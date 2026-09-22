/**
 * Drive background tabs in the current Google Chrome through the DSH extension.
 * Tabs stay in a DSH tab group and are not activated, so Chrome does not take focus.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { connectBridge } from "./bridge-client.js";
import { currentOwner, groupTitle } from "./owner.js";
import {
  BODY_LIMIT,
  CONSOLE_LIMIT,
  FIND_LIMIT,
  NETWORK_LIMIT,
  QUERY_LIMIT,
  SNAPSHOT_SCRIPT,
  a11yScript,
  assertA11y,
  assertBatch,
  assertButton,
  assertClickCount,
  assertDialog,
  assertDirection,
  assertEval,
  assertFill,
  assertFind,
  assertFormat,
  assertHistory,
  assertHttpUrl,
  assertKey,
  assertLimit,
  assertModifiers,
  assertPaths,
  assertPoint,
  assertRef,
  assertSelector,
  assertWait,
  boxScript,
  contentScript,
  elementScript,
  fillScript,
  findScript,
  fileInputScript,
  focusScript,
  formatA11y,
  formatComputedA11y,
  formatConsole,
  formatCookies,
  formatContent,
  formatDownloads,
  formatElement,
  formatEval,
  formatFill,
  formatFind,
  formatNetwork,
  frameMatchKey,
  matchFrameBox,
  formatStorage,
  formatObservation,
  formatQuery,
  formatText,
  queryScript,
  redactText,
  redactUrl,
  screenshotName,
  selectConsole,
  selectNetwork,
  scrollRefScript,
  scrollScript,
  textScript,
  typeScript,
  waitCheckScript,
} from "./page.js";

const NAV_MS = 20_000;
const ACTION_MS = 20_000;

let tail = Promise.resolve();
const pages = new Map();
let bridge = null;

function pageForTabSession(tabSessionId) {
  if (!tabSessionId) return null;
  for (const page of pages.values()) {
    if (page.sessionId === tabSessionId) return page;
  }
  return null;
}

/**
 * Run browser work one call at a time.
 * @template T
 * @param {(signal: AbortSignal | undefined) => Promise<T>} fn
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<T>}
 */
function exclusive(fn, signal) {
  const run = tail.then(() => {
    if (signal?.aborted) throw new Error("cancelled");
    return fn(signal);
  });
  tail = run.then(() => undefined, () => undefined);
  return run;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

class Cdp {
  /**
   * @param {WebSocket} ws
   */
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "CDP error"));
        else pending.resolve(message.result || {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("Chrome connection closed"));
      this.pending.clear();
    });
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {string | undefined} sessionId
   * @param {AbortSignal | undefined} signal
   * @param {number} [timeoutMs]
   */
  send(method, params = {}, sessionId, signal, timeoutMs = ACTION_MS) {
    if (this.closed) return Promise.reject(new Error("Chrome connection closed"));
    if (signal?.aborted) return Promise.reject(new Error("cancelled"));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.ws.send(JSON.stringify(payload));
    });
  }

  /**
   * @param {string} method
   * @param {string | undefined} sessionId
   * @param {((params: Record<string, unknown>) => boolean) | null} predicate
   * @param {number} timeoutMs
   * @param {AbortSignal | undefined} signal
   */
  waitFor(method, sessionId, predicate, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
      const onAbort = () => finish(new Error("cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        const params = message.params || {};
        if (predicate && !predicate(params)) return;
        finish(null, params);
      };
      const finish = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.listeners.delete(listener);
        if (error) reject(error);
        else resolve(value);
      };
      this.listeners.add(listener);
    });
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
  }
}

function pushLimited(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

function consoleText(params) {
  const args = Array.isArray(params.args) ? params.args : [];
  const text = args.map((arg) => {
    if (arg.value != null) return String(arg.value);
    return arg.description || arg.unserializableValue || arg.type || "";
  }).join(" ");
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function noteRequest(current, params) {
  const id = params.requestId;
  if (!id) return;
  current.network.set(id, {
    id,
    method: params.request?.method || "",
    url: redactUrl(params.request?.url || ""),
    type: params.type || "",
    status: "",
    failed: "",
  });
  while (current.network.size > 80) {
    const first = current.network.keys().next().value;
    current.network.delete(first);
  }
}

function noteDownload(current, params) {
  const id = params.guid || params.suggestedFilename || params.url;
  if (!id) return;
  const existing = current.downloads.find((item) => item.id === id);
  const next = {
    id,
    url: redactUrl(params.url || existing?.url || ""),
    filename: params.suggestedFilename || existing?.filename || "",
    state: params.state || existing?.state || "started",
  };
  if (existing) Object.assign(existing, next);
  else pushLimited(current.downloads, next, 20);
}

function onBrowserEvent(message) {
  const current = pageForTabSession(message.sessionId);
  if (!current) return;
  if (message.method === "Page.javascriptDialogOpening") {
    current.pendingDialog = {
      type: String(message.params?.type || "alert"),
      message: String(message.params?.message || ""),
      defaultPrompt: String(message.params?.defaultPrompt || ""),
    };
    return;
  }
  if (message.method === "Browser.downloadWillBegin" || message.method === "Browser.downloadProgress" || message.method === "Page.downloadWillBegin" || message.method === "Page.downloadProgress") {
    noteDownload(current, message.params || {});
    return;
  }
  if (message.method === "Runtime.executionContextCreated") {
    noteContext(current, message.params?.context);
    return;
  }
  if (message.method === "Runtime.executionContextDestroyed") {
    current.contexts?.delete(message.params?.executionContextId);
    return;
  }
  if (message.method === "Runtime.executionContextsCleared") {
    current.contexts = new Map();
    return;
  }
  if (message.method === "Runtime.consoleAPICalled") {
    pushLimited(current.console, { level: message.params?.type || "log", text: consoleText(message.params || {}) }, CONSOLE_LIMIT);
  } else if (message.method === "Runtime.exceptionThrown") {
    const details = message.params?.exceptionDetails || {};
    pushLimited(current.console, {
      level: "error",
      text: String(details.exception?.description || details.text || "exception").slice(0, 500),
    }, CONSOLE_LIMIT);
  } else if (message.method === "Network.requestWillBeSent") {
    noteRequest(current, message.params || {});
  } else if (message.method === "Network.responseReceived") {
    const id = message.params?.requestId;
    const row = id && current.network.get(id);
    if (row) {
      row.status = message.params.response?.status || "";
      row.mime = message.params.response?.mimeType || "";
      row.type = message.params.type || row.type;
    }
  } else if (message.method === "Network.loadingFailed") {
    const id = message.params?.requestId;
    const row = id && current.network.get(id);
    if (row) row.failed = message.params.errorText || "failed";
  }
}

async function ensure(signal) {
  const owner = currentOwner();
  const existing = pages.get(owner);
  if (existing && bridge && !bridge.closed && existing.sessionId) return existing;
  if (existing) pages.delete(owner);
  if (!bridge || bridge.closed) {
    bridge = new Cdp(await connectBridge(signal));
    bridge.listeners.add(onBrowserEvent);
  }
  await bridge.send("Target.setDiscoverTargets", { discover: true, dshOwner: owner }, undefined, signal);
  const page = await ensurePage(bridge, signal, undefined, owner);
  const state = {
    cdp: bridge,
    owner,
    ...page,
    dialog: "",
    pendingDialog: null,
    console: [],
    network: new Map(),
    downloads: [],
    launched: false,
    lastShot: "",
    blockedUrls: [],
    gif: null,
    contexts: new Map(),
    refOwners: new Map(),
  };
  pages.set(owner, state);
  await bridge.send("Runtime.disable", {}, state.sessionId, signal).catch(() => {});
  await bridge.send("Runtime.enable", {}, state.sessionId, signal);
  await delay(80, signal);
  return state;
}

function isControllablePage(target) {
  if (target.type !== "page") return false;
  const url = String(target.url || "");
  return !url.startsWith("chrome://") && !url.startsWith("devtools://") && !url.startsWith("chrome-extension://");
}

function adoptPage(current, page) {
  if (page.targetId !== current.targetId) {
    current.console = [];
    current.network = new Map();
    current.dialog = "";
    current.pendingDialog = null;
  }
  current.sessionId = page.sessionId;
  current.targetId = page.targetId;
}

async function ensurePage(cdp, signal, targetId, owner = currentOwner()) {
  const listed = await cdp.send("Target.getTargets", { dshOwner: owner }, undefined, signal);
  const pages = (listed.targetInfos || []).filter(isControllablePage);
  let target = targetId ? pages.find((page) => page.targetId === targetId) : pages[0];
  if (!target) {
    const created = await cdp.send("Target.createTarget", { url: "about:blank", dshOwner: owner }, undefined, signal);
    target = { targetId: created.targetId };
  }
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, undefined, signal);
  const sessionId = attached.sessionId;
  await cdp.send("Page.enable", {}, sessionId, signal);
  await cdp.send("Runtime.enable", {}, sessionId, signal);
  await cdp.send("Network.enable", { maxPostDataSize: 0 }, sessionId, signal).catch(() => {});
  return { sessionId, targetId: target.targetId };
}

async function evaluate(cdp, sessionId, expression, signal, timeoutMs = ACTION_MS) {
  return evaluateIn(cdp, sessionId, expression, undefined, signal, timeoutMs);
}

function noteContext(current, context) {
  if (!context?.id || !current.contexts) return;
  const aux = context.auxData || {};
  if (aux.type && aux.type !== "default") return;
  current.contexts.set(context.id, {
    id: context.id,
    origin: String(context.origin || ""),
    frameId: String(aux.frameId || ""),
  });
}

async function evaluateIn(cdp, sessionId, expression, contextId, signal, timeoutMs = ACTION_MS) {
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
  };
  if (contextId) params.contextId = contextId;
  const result = await cdp.send("Runtime.evaluate", params, sessionId, signal, timeoutMs);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(detail.exception?.description || detail.text || "page script failed");
  }
  return result.result?.value;
}

const FRAME_BOX_SCRIPT = `(() => Array.from(document.querySelectorAll("iframe")).map((frame) => {
  const box = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  return {
    src: frame.src || "",
    left: Math.round(box.left),
    top: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
    hidden: style.visibility === "hidden" || style.display === "none" || box.width < 2 || box.height < 2,
  };
}))()`;

function flattenFrames(node, top = true, out = []) {
  if (!node) return out;
  if (!top && node.frame) out.push(node.frame);
  for (const child of node.childFrames || []) flattenFrames(child, false, out);
  return out;
}

async function visibleChildFrames(current, signal) {
  if (!current.contexts) current.contexts = new Map();
  if (current.contexts.size === 0) {
    await current.cdp.send("Runtime.disable", {}, current.sessionId, signal).catch(() => {});
    await current.cdp.send("Runtime.enable", {}, current.sessionId, signal);
    await delay(80, signal);
  }
  const tree = await current.cdp.send("Page.getFrameTree", {}, current.sessionId, signal).catch(() => null);
  const frames = flattenFrames(tree?.frameTree);
  const boxes = await evaluate(current.cdp, current.sessionId, FRAME_BOX_SCRIPT, signal).catch(() => []);
  const visible = [];
  for (const frame of frames) {
    const box = matchFrameBox(frame.url, boxes);
    if (!box || box.hidden) continue;
    const context = [...current.contexts.values()].find((item) => item.frameId === frame.id);
    if (!context) continue;
    let crossOrigin = true;
    try {
      crossOrigin = new URL(frame.url).origin !== new URL(current.pageUrl || frame.url).origin;
    } catch {
      crossOrigin = true;
    }
    visible.push({
      contextId: context.id,
      url: frame.url,
      origin: context.origin,
      offset: { x: box.left || 0, y: box.top || 0 },
      crossOrigin,
    });
  }
  return visible;
}

function hostName(url) {
  try { return new URL(url).host; } catch { return "frame"; }
}

function adoptFrameElements(current, elements, meta) {
  const taken = [];
  for (const el of elements || []) {
    const globalRef = current.nextRef++;
    current.refOwners.set(globalRef, {
      contextId: meta.contextId,
      localRef: el.ref,
      url: meta.url,
      crossOrigin: meta.crossOrigin,
      offset: meta.offset,
    });
    taken.push({ ...el, ref: globalRef, frame: hostName(meta.url) });
  }
  return taken;
}

async function frameElements(current, signal, scriptFor) {
  const frames = await visibleChildFrames(current, signal);
  const found = [];
  for (const frame of frames) {
    try {
      const value = await evaluateIn(current.cdp, current.sessionId, scriptFor(), frame.contextId, signal, 4000);
      if (!value || value.ok === false) continue;
      found.push(...adoptFrameElements(current, value.elements, frame));
    } catch {
      // a frame can detach while it is being read
    }
  }
  return found;
}

async function frameOffset(current, owner, signal) {
  const boxes = await evaluate(current.cdp, current.sessionId, FRAME_BOX_SCRIPT, signal).catch(() => []);
  const match = matchFrameBox(owner.url, boxes);
  return { x: match?.left || owner.offset?.x || 0, y: match?.top || owner.offset?.y || 0 };
}

function owned(current, ref) {
  return current.refOwners?.get(ref) || null;
}

async function evalOwned(current, ref, scriptFor, signal) {
  const owner = owned(current, ref);
  return evaluateIn(current.cdp, current.sessionId, scriptFor(owner?.localRef ?? ref), owner?.contextId, signal);
}

function dialogLine(pending) {
  if (!pending) return "";
  const prompt = pending.type === "prompt" ? " Pass text to chrome_dialog when accepting a prompt." : "";
  return `${pending.type}: ${pending.message}.${prompt} Call chrome_dialog with accept or dismiss before the next action.`;
}

function blockedObservation(current) {
  return formatObservation({
    url: "",
    title: "",
    text: "(page is blocked by a dialog)",
    dialog: dialogLine(current.pendingDialog),
    elements: [],
  });
}

function assertNoDialog(current) {
  if (current.pendingDialog) {
    throw new Error(`dialog is open (${current.pendingDialog.type}); call chrome_dialog before another action`);
  }
}

async function observe(current, signal) {
  if (current.pendingDialog) return blockedObservation(current);
  await delay(120, signal);
  if (current.pendingDialog) return blockedObservation(current);
  try {
    const value = await evaluate(current.cdp, current.sessionId, SNAPSHOT_SCRIPT, signal, 4000);
    if (current.pendingDialog) return blockedObservation(current);
    current.pageUrl = value?.url || "";
    current.refOwners = new Map();
    const used = [...(value?.elements || []), ...(value?.offscreen || [])].map((el) => Number(el.ref) || 0);
    current.nextRef = Math.max(-1, ...used) + 1;
    const framed = await frameElements(current, signal, () => queryScript("input, textarea, button, select, a[href]", 20));
    if (framed.length) value.elements = [...(value.elements || []), ...framed];
    if (current.gif?.active && current.gif.frames.length < 30) {
      const frame = await captureFrame(current, signal).catch(() => Buffer.alloc(0));
      if (frame.length && current.gif?.frames.length < 30) current.gif.frames.push(frame);
    }
    return formatObservation({ ...value, dialog: current.dialog || "" });
  } catch (error) {
    if (current.pendingDialog) return blockedObservation(current);
    throw error;
  } finally {
    current.dialog = "";
  }
}

async function pointFrom(current, target, signal) {
  if (target.ref != null && target.ref !== "") {
    const index = assertRef(target.ref);
    const owner = owned(current, index);
    const box = await evalOwned(current, index, (local) => boxScript(local), signal);
    if (!box) throw new Error(`ref ${index} is not on the page; call chrome_snapshot, chrome_a11y, or chrome_find`);
    const offset = owner?.crossOrigin ? await frameOffset(current, owner, signal) : { x: 0, y: 0 };
    return { x: box.x + offset.x, y: box.y + offset.y };
  }
  return assertPoint(target.x, target.y);
}

async function mouse(current, type, point, signal) {
  await current.cdp.send("Input.dispatchMouseEvent", { type, ...point }, current.sessionId, signal);
}

async function waitForNavigation(current, href, signal) {
  const child = new AbortController();
  const onAbort = () => child.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const swallow = (promise) => promise.catch((error) => {
    if (child.signal.aborted) return null;
    throw error;
  });
  try {
    const loaded = swallow(current.cdp.waitFor("Page.loadEventFired", current.sessionId, null, NAV_MS, child.signal));
    const committed = swallow((async () => {
      const deadline = Date.now() + NAV_MS;
      while (Date.now() < deadline) {
        if (child.signal.aborted) return null;
        let url = "";
        try {
          url = await evaluate(current.cdp, current.sessionId, "location.href", child.signal);
        } catch (error) {
          if (error instanceof Error && error.message === "cancelled") return null;
        }
        if (url && url !== "about:blank" && (url === href || url.startsWith(href))) return url;
        await delay(200, child.signal).catch(() => null);
      }
      throw new Error("navigation did not commit");
    })());
    await Promise.race([loaded, committed]);
  } finally {
    child.abort();
    signal?.removeEventListener("abort", onAbort);
  }
  await delay(300, signal);
}

async function settle(current, signal) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("cancelled");
    try {
      const state = await evaluate(current.cdp, current.sessionId, "document.readyState", signal);
      if (state === "interactive" || state === "complete") return;
    } catch (error) {
      if (error instanceof Error && error.message === "cancelled") throw error;
    }
    await delay(150, signal);
  }
}

/**
 * @param {string} url
 * @param {{ newTab?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export function navigate(url, options = {}) {
  const href = assertHttpUrl(url);
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    assertNoDialog(current);
    if (options.newTab) {
      const created = await current.cdp.send("Target.createTarget", { url: "about:blank", dshOwner: current.owner }, undefined, signal);
      const page = await ensurePage(current.cdp, signal, created.targetId, current.owner);
      adoptPage(current, page);
    }
    const result = await current.cdp.send("Page.navigate", { url: href }, current.sessionId, signal, NAV_MS);
    if (result.errorText) throw new Error(result.errorText);
    await waitForNavigation(current, href, signal);
    return observe(current, signal);
  }, options.signal);
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function snapshot(signal) {
  return exclusive(async (active) => observe(await ensure(active), active), signal);
}

/**
 * @param {unknown} ref
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function click(ref, signal, options = {}) {
  const hasRef = ref != null && ref !== "";
  const hasPoint = options.x != null || options.y != null;
  if (!hasRef && !hasPoint) throw new Error("ref or x and y is required");
  const button = assertButton(options.button);
  const clickCount = assertClickCount(options.clickCount);
  const modifiers = assertModifiers(options.modifiers);
  return exclusive(async (active) => {
    const current = await ensure(active);
    assertNoDialog(current);
    const at = await pointFrom(current, { ref: hasRef ? ref : undefined, x: options.x, y: options.y }, active);
    const point = { x: at.x, y: at.y, button, clickCount, modifiers };
    await mouse(current, "mouseMoved", { x: at.x, y: at.y }, active);
    await mouse(current, "mousePressed", point, active);
    const navigated = current.cdp.waitFor(
      "Page.frameNavigated",
      current.sessionId,
      (params) => Boolean(params.frame) && !params.frame.parentId,
      1200,
      active,
    ).catch(() => null);
    await mouse(current, "mouseReleased", point, active);
    await navigated;
    await delay(200, active);
    return observe(current, active);
  }, signal);
}

/**
 * @param {unknown} ref
 * @param {unknown} text
 * @param {unknown} clear
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function typeInto(ref, text, clear, signal) {
  const index = assertRef(ref);
  const value = String(text ?? "");
  if (!value) throw new Error("text is required");
  const replace = clear !== false;
  return exclusive(async (active) => {
    const current = await ensure(active);
    assertNoDialog(current);
    const typed = await evalOwned(current, index, (local) => typeScript(local, value, replace), active);
    if (!typed?.ok) throw new Error(typed?.error || `ref ${index} is not editable`);
    if (typed.mode === "contenteditable") {
      await current.cdp.send("Input.insertText", { text: value }, current.sessionId, active);
    }
    await delay(150, active);
    return observe(current, active);
  }, signal);
}

/**
 * @param {unknown} key
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function press(key, signal, ref) {
  const mapped = assertKey(key);
  const index = ref == null || ref === "" ? null : assertRef(ref);
  return exclusive(async (active) => {
    const current = await ensure(active);
    assertNoDialog(current);
    if (index != null) {
      const focused = await evalOwned(current, index, (local) => focusScript(local), active);
      if (!focused?.ok) throw new Error(focused?.error || `ref ${index} is not on the page`);
    }
    const down = { ...mapped };
    await current.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...down }, current.sessionId, active);
    await current.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: mapped.key,
      code: mapped.code,
      windowsVirtualKeyCode: mapped.windowsVirtualKeyCode,
      modifiers: mapped.modifiers,
    }, current.sessionId, active);
    await settle(current, active);
    return observe(current, active);
  }, signal);
}

/**
 * @param {unknown} direction
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function scroll(direction, signal, ref, point) {
  const index = ref == null || ref === "" ? null : assertRef(ref);
  const at = point && (point.x != null || point.y != null) ? assertPoint(point.x, point.y) : null;
  const way = index == null ? assertDirection(direction || (at ? "down" : "")) : null;
  const amount = Math.min(10, Math.max(1, Number(point?.amount || 3) || 3));
  return exclusive(async (active) => {
    const current = await ensure(active);
    assertNoDialog(current);
    if (at) {
      const delta = amount * 120;
      const deltaX = way === "left" ? -delta : way === "right" ? delta : 0;
      const deltaY = way === "up" ? -delta : way === "down" ? delta : way === "bottom" ? 4000 : way === "top" ? -4000 : delta;
      await mouse(current, "mouseWheel", { x: at.x, y: at.y, deltaX, deltaY }, active);
    } else if (index != null) {
      const moved = await evalOwned(current, index, (local) => scrollRefScript(local), active);
      if (!moved?.ok) throw new Error(moved?.error || `ref ${index} is not on the page`);
    } else {
      await evaluate(current.cdp, current.sessionId, scrollScript(way), active);
    }
    await delay(200, active);
    return observe(current, active);
  }, signal);
}

/**
 * @param {unknown} action
 * @param {unknown} targetId
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function tabs(action, targetId, signal) {
  const name = String(action ?? "").trim();
  if (name !== "list" && name !== "switch" && name !== "close") {
    throw new Error("action must be list, switch, or close");
  }
  return exclusive(async (active) => {
    const current = await ensure(active);
    if (name === "list") {
      const listed = await current.cdp.send("Target.getTargets", { dshOwner: current.owner }, undefined, active);
      const pages = (listed.targetInfos || []).filter((target) => target.type === "page");
      const lines = ["tabs:"];
      for (const page of pages) {
        const mark = page.targetId === current.targetId ? "*" : " ";
        lines.push(`${mark} ${page.targetId} ${page.url || ""} ${page.title || ""}`.trimEnd());
      }
      if (pages.length === 0) lines.push("(none)");
      return lines.join("\n");
    }
    const id = String(targetId ?? "").trim();
    if (!id) throw new Error("target_id is required");
    if (name === "close") {
      await current.cdp.send("Target.closeTarget", { targetId: id }, undefined, active);
      if (id === current.targetId) {
        const page = await ensurePage(current.cdp, active);
        adoptPage(current, page);
      }
      return observe(current, active);
    }
    const page = await ensurePage(current.cdp, active, id);
    adoptPage(current, page);
    return observe(current, active);
  }, signal);
}

export function sessionCwd(exec) {
  try {
    const session = exec && exec.agent && exec.agent.session;
    if (!session) return null;
    if (session.header && typeof session.header.cwd === "string" && session.header.cwd) return session.header.cwd;
    if (typeof session.requestHeader === "function") {
      const header = session.requestHeader();
      if (header && typeof header.cwd === "string" && header.cwd) return header.cwd;
    }
  } catch {
    // optional
  }
  return null;
}

async function readPage(current, expression, signal) {
  const value = await evaluate(current.cdp, current.sessionId, expression, signal);
  if (value && value.ok === false) throw new Error(value.error || "page read failed");
  return value;
}

async function waitForLoad(current, signal) {
  const child = new AbortController();
  const onAbort = () => child.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const swallow = (promise) => promise.catch((error) => {
    if (child.signal.aborted) return null;
    throw error;
  });
  try {
    await Promise.race([
      swallow(current.cdp.waitFor("Page.loadEventFired", current.sessionId, null, NAV_MS, child.signal)),
      swallow(delay(1500, child.signal)),
    ]);
  } finally {
    child.abort();
    signal?.removeEventListener("abort", onAbort);
  }
  await settle(current, signal);
  await delay(200, signal);
}

/**
 * @param {{ selector?: unknown, ref?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function getText(options = {}) {
  const selector = options.selector ? assertSelector(options.selector) : "";
  const ref = options.ref == null || options.ref === "" ? null : assertRef(options.ref);
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    return formatText(await readPage(current, textScript(selector, ref), signal));
  }, options.signal);
}

/**
 * @param {{ format?: unknown, selector?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function content(options = {}) {
  const format = assertFormat(options.format);
  const selector = options.selector ? assertSelector(options.selector) : "";
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    return formatContent(await readPage(current, contentScript(selector, format), signal));
  }, options.signal);
}

/**
 * @param {unknown} selector
 * @param {unknown} limit
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function query(selector, limit, signal) {
  const wanted = assertSelector(selector);
  const count = assertLimit(limit, 30, QUERY_LIMIT);
  return exclusive(async (active) => {
    const current = await ensure(active);
    const value = await readPage(current, queryScript(wanted, count), active);
    current.refOwners = new Map();
    const used = (value.elements || []).map((el) => Number(el.ref) || 0);
    current.nextRef = Math.max(-1, ...used) + 1;
    const framed = await frameElements(current, active, () => queryScript(wanted, count));
    value.elements = [...(value.elements || []), ...framed];
    value.count = value.elements.length;
    return formatQuery(value);
  }, signal);
}

/**
 * @param {unknown} ref
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function element(ref, signal) {
  const index = assertRef(ref);
  return exclusive(async (active) => {
    const current = await ensure(active);
    return formatElement(await evalOwned(current, index, (local) => elementScript(local), active));
  }, signal);
}

/**
 * @param {unknown} ref
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function hover(ref, signal) {
  const index = assertRef(ref);
  return exclusive(async (active) => {
    const current = await ensure(active);
    const at = await pointFrom(current, { ref: index }, active);
    await current.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }, current.sessionId, active);
    await delay(300, active);
    return observe(current, active);
  }, signal);
}

/**
 * @param {unknown} action
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function history(action, signal) {
  const name = assertHistory(action);
  return exclusive(async (active) => {
    const current = await ensure(active);
    if (name === "reload") {
      await current.cdp.send("Page.reload", { ignoreCache: false }, current.sessionId, active, NAV_MS);
    } else {
      const listed = await current.cdp.send("Page.getNavigationHistory", {}, current.sessionId, active);
      const entries = listed.entries || [];
      const index = listed.currentIndex ?? 0;
      const next = name === "back" ? index - 1 : index + 1;
      const entry = entries[next];
      if (!entry) throw new Error(name === "back" ? "no back history" : "no forward history");
      await current.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, current.sessionId, active, NAV_MS);
    }
    await waitForLoad(current, active);
    return observe(current, active);
  }, signal);
}

/**
 * @param {{ selector?: unknown, text?: unknown, url?: unknown, ms?: unknown, state?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function waitFor(options = {}) {
  const spec = assertWait(options);
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    if (!spec.selector && !spec.text && !spec.url) {
      await delay(spec.ms, signal);
      return observe(current, signal);
    }
    const deadline = Date.now() + spec.ms;
    let reason = "not ready";
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("cancelled");
      const state = await evaluate(current.cdp, current.sessionId, waitCheckScript(spec), signal);
      if (state?.ok) {
        await delay(150, signal);
        return observe(current, signal);
      }
      reason = state?.reason || state?.error || "not ready";
      await delay(200, signal);
    }
    throw new Error(`timed out waiting: ${reason}`);
  }, options.signal);
}

/**
 * @param {unknown} expression
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function evaluateInPage(expression, signal, ref) {
  const source = assertEval(expression);
  const index = ref == null || ref === "" ? null : assertRef(ref);
  const wrapped = index == null
    ? source
    : `(() => { const element = window.__dshRefs && window.__dshRefs[${index}]; if (!element) throw new Error("ref not found"); return (${source}); })()`;
  return exclusive(async (active) => {
    const current = await ensure(active);
    const value = await evaluate(current.cdp, current.sessionId, wrapped, active);
    const shown = formatEval(value, false);
    return shown.length > 12000 ? `${shown.slice(0, 12000)}\ntruncated: true` : shown;
  }, signal);
}

/**
 * @param {unknown} limit
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function consoleLog(options, signal) {
  const spec = options && typeof options === "object" ? options : { limit: options };
  const count = assertLimit(spec.limit, 30, CONSOLE_LIMIT);
  const pattern = spec.pattern == null ? "" : String(spec.pattern);
  const onlyErrors = spec.onlyErrors === true || spec.only_errors === true;
  const clear = spec.clear === true;
  return exclusive(async (active) => {
    const current = await ensure(active);
    const shown = selectConsole(current.console, { pattern, onlyErrors, limit: count });
    if (clear) current.console = [];
    return formatConsole(shown);
  }, signal);
}

/**
 * @param {{ requestId?: unknown, limit?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function network(options = {}) {
  const count = assertLimit(options.limit, 30, NETWORK_LIMIT);
  const requestId = String(options.requestId ?? "").trim();
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    const entries = selectNetwork([...current.network.values()], options.url, count);
    if (!requestId) return formatNetwork(entries, null);
    let detail = null;
    try {
      const body = await current.cdp.send("Network.getResponseBody", { requestId }, current.sessionId, signal);
      const raw = body.base64Encoded ? Buffer.from(String(body.body || ""), "base64").toString("utf8") : String(body.body || "");
      detail = redactText(raw, BODY_LIMIT);
    } catch (error) {
      detail = { text: error instanceof Error ? error.message : "response body is not available", truncated: false, redacted: false };
    }
    return formatNetwork(entries, detail);
  }, options.signal);
}

/**
 * @param {unknown} ref
 * @param {unknown} paths
 * @param {{ cwd?: string | null, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export function upload(ref, paths, options = {}) {
  const index = assertRef(ref);
  const files = assertPaths(paths).map((file) => path.isAbsolute(file) ? file : path.resolve(options.cwd || process.cwd(), file));
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    for (const file of files) {
      try {
        await access(file);
      } catch {
        throw new Error(`file not found: ${file}`);
      }
    }
    const remote = await current.cdp.send("Runtime.evaluate", {
      expression: fileInputScript(index),
      returnByValue: false,
      awaitPromise: true,
    }, current.sessionId, signal);
    if (remote.exceptionDetails) {
      const detail = remote.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || "file input was not found");
    }
    const objectId = remote.result?.objectId;
    if (!objectId) throw new Error("file input was not found");
    await current.cdp.send("DOM.enable", {}, current.sessionId, signal).catch(() => {});
    try {
      await current.cdp.send("DOM.setFileInputFiles", { files, objectId }, current.sessionId, signal);
    } finally {
      await current.cdp.send("Runtime.releaseObject", { objectId }, current.sessionId, signal).catch(() => {});
    }
    await delay(150, signal);
    return observe(current, signal);
  }, options.signal);
}

/**
 * @param {{ fullPage?: boolean, ref?: unknown, path?: unknown, cwd?: string | null, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function screenshot(options = {}) {
  const index = options.ref == null || options.ref === "" ? null : assertRef(options.ref);
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    const params = { format: "png" };
    let note = "";
    if (options.region) {
      const region = options.region;
      const scale = Math.min(4, Math.max(1, Number(region.scale || 2) || 2));
      params.clip = {
        x: region.x,
        y: region.y,
        width: Math.max(1, region.width),
        height: Math.max(1, region.height),
        scale,
      };
    } else if (index != null) {
      const owner = owned(current, index);
      const box = await evalOwned(current, index, (local) => boxScript(local), signal);
      if (!box || box.width < 2 || box.height < 2) throw new Error(`ref ${index} is not visible`);
      const offset = owner?.crossOrigin ? await frameOffset(current, owner, signal) : { x: 0, y: 0 };
      params.clip = { x: box.left + offset.x, y: box.top + offset.y, width: box.width, height: box.height, scale: 1 };
    } else if (options.fullPage) {
      const metrics = await current.cdp.send("Page.getLayoutMetrics", {}, current.sessionId, signal);
      const css = metrics.cssContentSize || metrics.contentSize || {};
      const width = Math.max(1, Math.min(Math.ceil(css.width || 1280), 1920));
      const fullHeight = Math.ceil(css.height || 900);
      const height = Math.max(1, Math.min(fullHeight, 4000));
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width, height, scale: 1 };
      if (fullHeight > 4000) note = "full page height capped at 4000px";
    }
    const shot = await current.cdp.send("Page.captureScreenshot", params, current.sessionId, signal, 20000);
    const bytes = Buffer.from(String(shot.data || ""), "base64");
    if (bytes.length === 0) throw new Error("Chrome returned an empty screenshot");
    const dir = options.cwd ? path.join(options.cwd, "chrome-screenshots") : path.join(dshHome(), "cache", "chrome-screenshots");
    const requested = String(options.path ?? "").trim();
    const dest = requested
      ? (path.isAbsolute(requested) ? requested : path.join(options.cwd || dir, requested))
      : path.join(dir, screenshotName());
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
    const lines = [`saved ${dest}`, `bytes: ${bytes.length}`];
    if (note) lines.push(note);
    current.lastShot = dest;
    const image = bytes.length <= 800_000 ? bytes.toString("base64") : "";
    if (!image) lines.push("Image is too large to inline. Use read_image on this path.");
    if (current.gif?.active && bytes.length) current.gif.frames.push(bytes);
    return { text: lines.join("\n"), image };
  }, options.signal);
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function downloads(signal) {
  return exclusive(async (active) => {
    const current = await ensure(active);
    const listed = await current.cdp.send("Browser.getDownloadItems", { dshOwner: current.owner }, undefined, active).catch(() => null);
    if (listed && Array.isArray(listed.items)) current.downloads = listed.items;
    return formatDownloads(current.downloads, "current Chrome download folder");
  }, signal);
}

/**
 * @param {{ ref?: unknown, x?: unknown, y?: unknown }} from
 * @param {{ ref?: unknown, x?: unknown, y?: unknown }} to
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function drag(from, to, signal) {
  return exclusive(async (active) => {
    const current = await ensure(active);
    assertNoDialog(current);
    const start = await pointFrom(current, from, active);
    const end = await pointFrom(current, to, active);
    await mouse(current, "mouseMoved", start, active);
    await mouse(current, "mousePressed", { ...start, button: "left", clickCount: 1 }, active);
    for (let step = 1; step <= 8; step += 1) {
      await mouse(current, "mouseMoved", {
        x: start.x + ((end.x - start.x) * step) / 8,
        y: start.y + ((end.y - start.y) * step) / 8,
        button: "left",
      }, active);
    }
    await mouse(current, "mouseReleased", { ...end, button: "left", clickCount: 1 }, active);
    await delay(200, active);
    return observe(current, active);
  }, signal);
}

/**
 * @param {{ filter?: unknown, depth?: unknown, ref?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
async function bindAxRef(current, backendNodeId, signal) {
  if (!backendNodeId) return null;
  const resolved = await current.cdp.send("DOM.resolveNode", { backendNodeId }, current.sessionId, signal);
  const objectId = resolved.object?.objectId;
  if (!objectId) return null;
  try {
    const called = await current.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (!this || this.nodeType !== 1) return null;
        if (!window.__dshRefs) window.__dshRefs = [];
        var ref = window.__dshRefs.length;
        window.__dshRefs.push(this);
        try { this.setAttribute("data-dsh-ref", String(ref)); } catch (error) {}
        return ref;
      }`,
      returnByValue: true,
    }, current.sessionId, signal);
    return called.result?.value ?? null;
  } finally {
    await current.cdp.send("Runtime.releaseObject", { objectId }, current.sessionId, signal).catch(() => {});
  }
}

async function computedA11y(current, spec, signal) {
  await current.cdp.send("Accessibility.enable", {}, current.sessionId, signal);
  await current.cdp.send("DOM.enable", {}, current.sessionId, signal).catch(() => {});
  const listed = await current.cdp.send("Accessibility.getFullAXTree", {}, current.sessionId, signal);
  const nodes = listed.nodes || [];
  await evaluate(current.cdp, current.sessionId, "window.__dshRefs = []", signal);
  let bound = 0;
  for (const node of nodes) {
    if (bound >= 80 || node.ignored || !node.backendDOMNodeId) continue;
    const role = String(node.role?.value || "");
    if (!/button|link|textbox|searchbox|combobox|checkbox|radio|tab|menuitem|switch|slider|option|heading|image/i.test(role)) continue;
    node.ref = await bindAxRef(current, node.backendDOMNodeId, signal);
    if (node.ref != null) bound += 1;
  }
  return formatComputedA11y({ filter: spec.filter, nodes, depth: spec.depth });
}

export function a11y(options = {}) {
  const spec = assertA11y(options);
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    if (current.pendingDialog) return blockedObservation(current);
    try {
      return await computedA11y(current, spec, signal);
    } catch {
      const value = await readPage(current, a11yScript(spec), signal);
      return `${formatA11y(value)}\nsource: dom-fallback`;
    }
  }, options.signal);
}

/**
 * @param {unknown} query
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function find(query, signal) {
  const text = assertFind(query);
  return exclusive(async (active) => {
    const current = await ensure(active);
    if (current.pendingDialog) return blockedObservation(current);
    const value = await readPage(current, findScript(text, FIND_LIMIT), active);
    current.refOwners = new Map();
    const used = (value.elements || []).map((el) => Number(el.ref) || 0);
    current.nextRef = Math.max(-1, ...used) + 1;
    const framed = await frameElements(current, active, () => findScript(text, FIND_LIMIT));
    value.elements = [...(value.elements || []), ...framed].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, FIND_LIMIT);
    value.count = value.elements.length;
    return formatFind(value);
  }, signal);
}

/**
 * @param {unknown} fields
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function fill(fields, signal) {
  const items = assertFill(fields);
  return exclusive(async (active) => {
    const current = await ensure(active);
    assertNoDialog(current);
    const value = await readPage(current, fillScript(items), active);
    const summary = formatFill(value);
    const page = await observe(current, active);
    return `${summary}\n${page}`;
  }, signal);
}

/**
 * @param {unknown} action
 * @param {unknown} text
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function handleDialog(action, text, signal) {
  const name = assertDialog(action);
  return exclusive(async (active) => {
    const current = await ensure(active);
    if (!current.pendingDialog) throw new Error("no dialog is open");
    await current.cdp.send("Page.handleJavaScriptDialog", {
      accept: name === "accept",
      promptText: text == null ? "" : String(text),
    }, current.sessionId, active);
    current.pendingDialog = null;
    await delay(200, active);
    return observe(current, active);
  }, signal);
}

function shortcutFile() {
  return path.join(dshHome(), "cache", "chrome-shortcuts.json");
}

async function readShortcuts() {
  try {
    return JSON.parse(await readFile(shortcutFile(), "utf8"));
  } catch {
    return {};
  }
}

async function runStep(step, signal) {
  if (step.action === "navigate") return navigate(step.url, { newTab: step.new_tab === true, signal });
  if (step.action === "click") return click(step.ref, signal, { x: step.x, y: step.y, button: step.button, clickCount: step.click_count, modifiers: step.modifiers });
  if (step.action === "type") return typeInto(step.ref, step.text, step.clear, signal);
  if (step.action === "press") return press(step.key, signal, step.ref);
  if (step.action === "scroll") return scroll(step.direction, signal, step.ref, { x: step.x, y: step.y, amount: step.amount });
  if (step.action === "hover") return hover(step.ref, signal);
  if (step.action === "fill") return fill(step.fields, signal);
  if (step.action === "wait") return waitFor({ selector: step.selector, text: step.text, url: step.url, ms: step.ms, state: step.state, signal });
  throw new Error(`unsupported action ${step.action}`);
}

/**
 * @param {unknown} actions
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export async function batch(actions, signal) {
  const steps = assertBatch(actions);
  const lines = [];
  for (let index = 0; index < steps.length; index += 1) {
    lines.push(`step ${index + 1} ${steps[index].action}:`);
    lines.push(await runStep(steps[index], signal));
  }
  return lines.join("\n");
}

/**
 * @param {number} width
 * @param {number} height
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function resize(width, height, signal) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200 || w > 3840 || h > 2160) {
    throw new Error("width and height must be between 200 and 3840x2160");
  }
  return exclusive(async (active) => {
    const current = await ensure(active);
    const found = await current.cdp.send("Browser.getWindowForTarget", { targetId: current.targetId }, undefined, active);
    const bounds = found.bounds || {};
    return `window left unchanged so Chrome stays in the background: ${bounds.width || "?"}x${bounds.height || "?"}\n${await observe(current, active)}`;
  }, signal);
}

/**
 * @param {{ ref?: unknown, x?: unknown, y?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function uploadImage(options = {}) {
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    if (!current.lastShot) throw new Error("no screenshot yet; call chrome_screenshot first");
    if (options.ref != null && options.ref !== "") {
      const files = [current.lastShot];
      const index = assertRef(options.ref);
      const remote = await current.cdp.send("Runtime.evaluate", {
        expression: fileInputScript(index),
        returnByValue: false,
      }, current.sessionId, signal);
      const objectId = remote.result?.objectId;
      if (!objectId) throw new Error(remote.exceptionDetails?.text || "file input was not found");
      await current.cdp.send("DOM.setFileInputFiles", { files, objectId }, current.sessionId, signal);
      await current.cdp.send("Runtime.releaseObject", { objectId }, current.sessionId, signal).catch(() => {});
      return observe(current, signal);
    }
    const at = assertPoint(options.x, options.y);
    const found = await evaluate(current.cdp, current.sessionId, `(() => {
      const el = document.elementFromPoint(${at.x}, ${at.y});
      if (!el) return { ok: false, error: "no element at that point" };
      const input = el.closest && el.closest("input[type=file]") || (el.matches && el.matches("input[type=file]") ? el : null);
      if (!input) return { ok: false, error: "point is not a file input" };
      if (!window.__dshRefs) window.__dshRefs = [];
      const ref = window.__dshRefs.length;
      window.__dshRefs.push(input);
      return { ok: true, ref };
    })()`, signal);
    if (!found?.ok) {
      const shot = await readFile(current.lastShot);
      await current.cdp.send("Input.setInterceptDrags", { enabled: true }, current.sessionId, signal).catch(() => {});
      const data = { items: [{ mimeType: "image/png", data: shot.toString("base64") }], dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await current.cdp.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data }, current.sessionId, signal).catch(() => {});
      }
      return `drop attempted at ${at.x},${at.y}. File inputs are reliable; coordinate drops only work if the page accepts a drag. Last screenshot: ${current.lastShot}`;
    }
    const files = [current.lastShot];
    const remote = await current.cdp.send("Runtime.evaluate", {
      expression: fileInputScript(found.ref),
      returnByValue: false,
    }, current.sessionId, signal);
    const objectId = remote.result?.objectId;
    if (!objectId) throw new Error("file input was not found");
    await current.cdp.send("DOM.setFileInputFiles", { files, objectId }, current.sessionId, signal);
    await current.cdp.send("Runtime.releaseObject", { objectId }, current.sessionId, signal).catch(() => {});
    return observe(current, signal);
  }, options.signal);
}

/**
 * @param {{ area?: unknown, action?: unknown, name?: unknown, value?: unknown, showValues?: boolean, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function storage(options = {}) {
  const area = String(options.area || "cookie");
  const action = String(options.action || "list");
  if (!["cookie", "local", "session"].includes(area)) throw new Error("area must be cookie, local, or session");
  if (!["list", "get", "set", "delete", "clear"].includes(action)) throw new Error("action must be list, get, set, delete, or clear");
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    const name = String(options.name || "");
    const value = options.value == null ? "" : String(options.value);
    if (area === "cookie") {
      if (action === "list" || action === "get") {
        const listed = await current.cdp.send("Network.getCookies", {}, current.sessionId, signal);
        const cookies = (listed.cookies || []).filter((cookie) => !name || cookie.name === name);
        return formatCookies(cookies, options.showValues === true);
      }
      const pageUrl = await evaluate(current.cdp, current.sessionId, "location.href", signal);
      if (action === "clear") {
        const listed = await current.cdp.send("Network.getCookies", {}, current.sessionId, signal);
        for (const cookie of listed.cookies || []) {
          await current.cdp.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain }, current.sessionId, signal);
        }
        return "cookies cleared for the current page";
      }
      if (!name) throw new Error("name is required");
      if (action === "delete") {
        await current.cdp.send("Network.deleteCookies", { name, url: pageUrl }, current.sessionId, signal);
        return `deleted cookie ${name}`;
      }
      await current.cdp.send("Network.setCookie", { name, value, url: pageUrl }, current.sessionId, signal);
      return `set cookie ${name}`;
    }
    const store = area === "local" ? "localStorage" : "sessionStorage";
    if (action === "list" || action === "get") {
      const items = await evaluate(current.cdp, current.sessionId, `(() => {
        const store = ${store};
        const wanted = ${JSON.stringify(name)};
        const names = wanted ? [wanted] : Object.keys(store);
        return names.filter((key) => store.getItem(key) != null).map((key) => ({ name: key, value: store.getItem(key) }));
      })()`, signal);
      return formatStorage(area, items, options.showValues === true);
    }
    if (!name && action !== "clear") throw new Error("name is required");
    await evaluate(current.cdp, current.sessionId, `(() => {
      const store = ${store};
      const action = ${JSON.stringify(action)};
      const name = ${JSON.stringify(name)};
      const value = ${JSON.stringify(value)};
      if (action === "clear") store.clear();
      else if (action === "delete") store.removeItem(name);
      else store.setItem(name, value);
      return true;
    })()`, signal);
    return `${area} ${action} ${name}`.trim();
  }, options.signal);
}

/**
 * @param {{ action?: unknown, pattern?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export function route(options = {}) {
  const action = String(options.action || "");
  if (!["offline", "online", "block", "unblock", "clear"].includes(action)) {
    throw new Error("action must be offline, online, block, unblock, or clear");
  }
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    if (action === "offline" || action === "online") {
      await current.cdp.send("Network.emulateNetworkConditions", {
        offline: action === "offline",
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      }, current.sessionId, signal);
      return action === "offline" ? "network: offline" : "network: online";
    }
    const pattern = String(options.pattern || "").trim();
    if (action === "clear") current.blockedUrls = [];
    else if (!pattern) throw new Error("pattern is required");
    else if (action === "block") current.blockedUrls = [...new Set([...current.blockedUrls, pattern])];
    else current.blockedUrls = current.blockedUrls.filter((item) => item !== pattern);
    await current.cdp.send("Network.setBlockedURLs", { urls: current.blockedUrls }, current.sessionId, signal);
    return `blocked: ${current.blockedUrls.join(", ") || "(none)"}`;
  }, options.signal);
}

async function captureFrame(current, signal) {
  const shot = await current.cdp.send("Page.captureScreenshot", { format: "png" }, current.sessionId, signal, 10000);
  return Buffer.from(String(shot.data || ""), "base64");
}

/**
 * @param {unknown} action
 * @param {{ cwd?: string | null, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export function gif(action, options = {}) {
  const name = String(action || "");
  if (name !== "start" && name !== "stop") throw new Error("action must be start or stop");
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    if (name === "start") {
      const first = await captureFrame(current, signal);
      current.gif = { active: true, frames: first.length ? [first] : [] };
      return "gif: recording. Later page actions add frames. Call chrome_gif stop to save it.";
    }
    if (current.gif?.active && current.gif.frames.length < 30) {
      const last = await captureFrame(current, signal);
      if (last.length) current.gif.frames.push(last);
    }
    const frames = current.gif?.frames || [];
    current.gif = null;
    if (frames.length === 0) throw new Error("no gif frames were captured");
    const dir = path.join(options.cwd || path.join(dshHome(), "cache"), "chrome-gifs");
    await mkdir(dir, { recursive: true });
    const stamp = screenshotName().replace(/\.png$/, "");
    const frameDir = path.join(dir, stamp);
    await mkdir(frameDir, { recursive: true });
    for (let index = 0; index < frames.length; index += 1) {
      await writeFile(path.join(frameDir, `frame-${String(index).padStart(3, "0")}.png`), frames[index]);
    }
    const dest = path.join(dir, `${stamp}.gif`);
    let encoder = "";
    for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
      try {
        await access(candidate);
        encoder = candidate;
        break;
      } catch {
        // try next
      }
    }
    if (!encoder) return `saved frames ${frameDir}\nffmpeg was not found, so no gif was encoded.`;
    await new Promise((resolve, reject) => {
      const child = spawn(encoder, [
        "-y", "-framerate", "2", "-i", path.join(frameDir, "frame-%03d.png"),
        "-vf", "scale=800:-1:flags=lanczos", dest,
      ], { stdio: "ignore" });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    });
    return `saved ${dest}\nframes: ${frames.length}`;
  }, options.signal);
}

/**
 * @param {{ action?: unknown, name?: unknown, actions?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export async function shortcut(options = {}) {
  const action = String(options.action || "list");
  const stored = await readShortcuts();
  if (action === "list") {
    const names = Object.keys(stored);
    return names.length ? names.map((name) => `${name} (${stored[name].length} steps)`).join("\n") : "(none)";
  }
  const name = String(options.name || "").trim();
  if (!name) throw new Error("name is required");
  if (action === "save") {
    stored[name] = assertBatch(options.actions);
    await mkdir(path.dirname(shortcutFile()), { recursive: true });
    await writeFile(shortcutFile(), JSON.stringify(stored, null, 2));
    return `saved shortcut ${name}`;
  }
  if (action === "run") {
    if (!stored[name]) throw new Error(`shortcut not found: ${name}`);
    return batch(stored[name], options.signal);
  }
  throw new Error("action must be list, save, or run");
}

/**
 * @param {unknown} action
 * @param {unknown} port
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function browsers(action) {
  const name = String(action || "list");
  if (name === "list") {
    return Promise.resolve([
      "mode: current Chrome extension",
      `group: ${groupTitle(currentOwner())}`,
      "focus: background tabs, Chrome is not activated",
      `conversations: ${pages.size}`,
      bridge && !bridge.closed ? "bridge: connected" : "bridge: not connected",
    ].join("\n"));
  }
  throw new Error("This build controls the current Chrome through the DSH extension. It does not attach to a debug port.");
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function closeBrowser(signal) {
  return exclusive(async () => {
    await shutdown();
    return "closed this conversation's DSH tab group. Other conversations and Chrome stay open.";
  }, signal);
}

/** Close the DSH tab group. Does not quit Chrome. */
export async function shutdown() {
  const owner = currentOwner();
  const current = pages.get(owner);
  pages.delete(owner);
  if (!current || current.cdp.closed) return;
  try {
    await current.cdp.send("Browser.close", { dshOwner: owner }, undefined, undefined, 3000);
  } catch {
    // already gone
  }
  if (pages.size === 0 && bridge) {
    bridge.close();
    bridge = null;
  }
}

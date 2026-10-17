/**
 * Drive background tabs in the current Google Chrome through the DSH extension.
 * Tabs stay in a DSH tab group and are not activated, so Chrome does not take focus.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { assertBrowserPath, readBrowserFile, writeBrowserFile } from "./files.js";
import os from "node:os";
import path from "node:path";
import { connectBridge } from "./bridge-client.js";
import { currentOwner, groupTitle } from "./owner.js";
import { browserExecutionVersions, extensionExecution, validateExtensionEngine } from "./execution.js";
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

const ownerTails = new Map();
const pages = new Map();
const captureSessions = new Map();
const ownerCleanups = new Map();
const resourceActivity = new Map();
const unconfirmedCreates = new Map();
let bridgeSequence = 0;
let bridge = null;
let bridgeConnecting = null;

function pageForTabSession(tabSessionId) {
  if (!tabSessionId) return null;
  for (const page of pages.values()) {
    if (page.sessionId === tabSessionId) return page;
  }
  return null;
}

/**
 * Serialize one owner's work, never an unrelated conversation's queue.
 * Capture holds its originating queue but carries a distinct resource lease.
 * @template T
 * @param {(signal: AbortSignal | undefined) => Promise<T>} fn
 * @param {AbortSignal | undefined} signal
 * @param {object | undefined} captureLease
 * @returns {Promise<T>}
 */
function exclusive(fn, signal, captureLease) {
  const owner = currentOwner();
  let started = false;
  let rejectQueued;
  const onQueuedAbort = () => {
    if (!started) {
      signal?.removeEventListener("abort", onQueuedAbort);
      rejectQueued?.(new Error("cancelled"));
    }
  };
  const run = (ownerTails.get(owner) || Promise.resolve()).then(async () => {
    started = true;
    signal?.removeEventListener("abort", onQueuedAbort);
    if (signal?.aborted) throw new Error("cancelled");
    const activity = resourceActivity.get(owner) || 0;
    try {
      const value = await fn(signal);
      if (signal?.aborted) throw new Error("cancelled");
      return value;
    } finally {
      if (signal?.aborted) {
        if (captureLease) {
          // The capture closes its distinct owner before releasing this queue.
          if (!["queued", "closed"].includes(captureLease.state)) throw cleanupPending(captureLease.error || "capture cleanup is unconfirmed");
        } else if ((resourceActivity.get(owner) || 0) !== activity) {
          await settleOwner({ owner, connection: bridge, state: "open" });
        }
      }
    }
  });
  const tail = run.then(() => undefined, () => undefined);
  ownerTails.set(owner, tail);
  tail.then(() => { if (ownerTails.get(owner) === tail) ownerTails.delete(owner); });
  if (!signal) return run;
  return new Promise((resolve, reject) => {
    rejectQueued = reject;
    signal.addEventListener("abort", onQueuedAbort, { once: true });
    if (signal.aborted) onQueuedAbort();
    run.then(resolve, reject);
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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
    this.sequence = ++bridgeSequence;
    this.engine = ws.hello?.engine;
    this.next = 1;
    this.pending = new Map();
    this.creations = new Map(); // Wire settlement survives caller timeout/abort.
    this.sessionOwners = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener("message", (event) => {
      if (this.closed) return;
      const message = JSON.parse(String(event.data));
      const creation = this.creations.get(message.id);
      if (creation) {
        this.creations.delete(message.id);
        creation.resolve();
      }
      if (message.method === "Target.detachedFromTarget" || message.method === "Target.targetDestroyed") {
        const sessionId = message.params?.sessionId || message.sessionId || message.params?.targetId;
        for (const [id, pending] of this.pending) {
          if (sessionId && pending.sessionId === sessionId) {
            this.pending.delete(id);
            pending.reject(new Error("Chrome tab session disconnected"));
          }
        }
      }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!message.error && pending.method === "Target.attachToTarget" && message.result?.sessionId) {
          this.sessionOwners.set(message.result.sessionId, pending.owner);
        }
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || "CDP error"), typeof message.error.code === "string" ? { code: message.error.code } : {}));
        else pending.resolve(message.result || {});
        return;
      }
      if (!creation) for (const listener of this.listeners) listener(message);
      if (message.method === "Target.detachedFromTarget" || message.method === "Target.targetDestroyed") {
        this.sessionOwners.delete(message.params?.sessionId || message.sessionId || message.params?.targetId);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("Chrome connection closed"));
      this.pending.clear();
      for (const creation of this.creations.values()) {
        const unknown = Object.freeze({ owner: creation.owner, scope: creation.scope, requestId: creation.requestId, connection: this.sequence,
          workerGeneration: creation.workerGeneration, startedAt: creation.startedAt, disconnectedAt: Date.now() });
        const retained = [...(unconfirmedCreates.get(creation.owner) || []), unknown];
        unconfirmedCreates.set(creation.owner, retained);
        const record = captureSessions.get(creation.owner) || ownerCleanups.get(creation.owner) || { owner: creation.owner, connection: this };
        record.state = "retained";
        record.error = "Chrome disconnected with an unacknowledged actual create; its worker generation must be proved before cleanup can succeed";
        record.unconfirmedCreates = retained;
        ownerCleanups.set(creation.owner, record);
        creation.resolve(); // Release local waiting, not a claim of Chrome settlement.
      }
      this.creations.clear();
      this.sessionOwners.clear();
      for (const listener of this.listeners) listener({ method: "DSH.connectionClosed" });
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
    const owner = params.dshOwner || currentOwner();
    if (sessionId || ["Target.createTarget", "Target.attachToTarget", "Target.closeTarget"].includes(method)) {
      resourceActivity.set(owner, (resourceActivity.get(owner) || 0) + 1);
    }
    if (method === "Target.createTarget") {
      let resolve;
      const settled = new Promise(done => { resolve = done; });
      this.creations.set(id, { owner, scope: captureSessions.get(owner)?.scope || Object.freeze({ sessionId: owner }), workerGeneration: this.engine?.workerGeneration || null, requestId: id, startedAt: Date.now(), settled, resolve });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => finish(new Error("cancelled"));
      const timer = setTimeout(() => finish(new Error(`${method} timed out`)), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        sessionId,
        method,
        owner,
        resolve: (value) => finish(null, value),
        reject: (error) => finish(error),
      });
      try {
        const payload = { id, method, params: { ...params, dshOwner: owner } };
        if (sessionId) payload.sessionId = sessionId;
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        const creation = this.creations.get(id);
        this.creations.delete(id);
        creation?.resolve();
        finish(error);
      }
    });
  }

  async settleCreates(owner, timeoutMs) {
    const creating = [...this.creations.values()].filter(item => item.owner === owner);
    if (!creating.length) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chrome target creation settlement timed out")), timeoutMs);
      Promise.all(creating.map(item => item.settled)).then(() => { clearTimeout(timer); resolve(); });
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
        if ((message.method === "Target.detachedFromTarget" || message.method === "Target.targetDestroyed")
          && sessionId && sessionId === (message.params?.sessionId || message.sessionId || message.params?.targetId)) {
          finish(new Error("Chrome tab session disconnected"));
          return;
        }
        if (message.method !== method) return;
        if (sessionId && message.sessionId !== sessionId) return;
        const params = message.params || {};
        if (predicate && !predicate(params, message)) return;
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
      if (signal?.aborted) onAbort();
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

function onBrowserEvent(message) {
  if (message.method === "DSH.connectionClosed") {
    pages.clear();
    return;
  }
  if (message.method === "Target.detachedFromTarget" || message.method === "Target.targetDestroyed") {
    const sessionId = message.params?.sessionId || message.sessionId;
    const targetId = message.params?.targetId;
    for (const [owner, page] of pages) {
      if ((sessionId && page.sessionId === sessionId) || (targetId && page.targetId === targetId)) {
        pages.delete(owner);
      }
    }
    return;
  }
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
  if (message.method === "Runtime.executionContextCreated") {
    noteContext(current, message.params?.context);
    return;
  }
  if (message.method === "Page.frameNavigated") {
    const frame = message.params?.frame;
    if (frame?.id) invalidateRefWorld(current, frame.id, !frame.parentId);
    return;
  }
  if (message.method === "Runtime.executionContextDestroyed") {
    const id = message.params?.executionContextId;
    current.contexts?.delete(id);
    const frameId = current.refWorldFrames?.get(id);
    if (frameId) invalidateRefWorld(current, frameId, frameId === current.mainFrameId);
    return;
  }
  if (message.method === "Runtime.executionContextsCleared") {
    current.contexts = new Map();
    const frames = [...(current.refWorlds?.keys() || [])];
    current.refWorlds = new Map();
    current.refWorldIds = new Set();
    current.refWorldFrames = new Map();
    current.refOwners = new Map();
    current.refsStale = true;
    const frameId = current.mainFrameId || frames[0];
    if (frameId) invalidateRefWorld(current, frameId, true);
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

// Owners share one admitted controller. Cancelling A's waiter must not cancel
// B's pending connection, establish a competing socket, or close B's live link.
async function ensureBridge(signal) {
  if (signal?.aborted) throw new Error("cancelled");
  if (bridge && !bridge.closed) return bridge;
  if (!bridgeConnecting || bridgeConnecting.controller.signal.aborted) {
    const connecting = { controller: new AbortController(), waiters: new Set(), settled: false };
    bridgeConnecting = connecting;
    connecting.promise = Promise.resolve().then(async () => {
      const link = await connectBridge(connecting.controller.signal);
      if (connecting.controller.signal.aborted) {
        link.close();
        throw new Error("cancelled");
      }
      const connection = new Cdp(link);
      pages.clear(); // Discard transport-bound refs/state, never real tabs.
      bridge = connection;
      connection.listeners.add((message) => {
        if (bridge !== connection) return;
        onBrowserEvent(message);
      });
      return connection;
    }).finally(() => {
      connecting.settled = true;
      if (bridgeConnecting === connecting) bridgeConnecting = null;
    });
  }
  const connecting = bridgeConnecting;
  return new Promise((resolve, reject) => {
    const waiter = {};
    let settled = false;
    connecting.waiters.add(waiter);
    const finish = (error, connection) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      connecting.waiters.delete(waiter);
      if (!connecting.waiters.size && !connecting.settled) connecting.controller.abort();
      if (error) reject(error);
      else resolve(connection);
    };
    const onAbort = () => finish(new Error("cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    connecting.promise.then(connection => finish(null, connection), error => finish(error));
  });
}

async function ensure(signal) {
  const owner = currentOwner();
  const execution = extensionExecution(owner);
  await ensureBridge(signal);
  const engine = validateExtensionEngine(execution, bridge.engine);
  const existing = pages.get(owner);
  if (existing && existing.cdp === bridge && existing.sessionId) return existing;
  if (existing) pages.delete(owner);
  await bridge.send("Target.setDiscoverTargets", { discover: true, dshOwner: owner }, undefined, signal);
  const page = await ensurePage(bridge, signal, undefined, owner);
  const state = {
    cdp: bridge,
    owner,
    execution,
    engine,
    ...page,
    dialog: "",
    pendingDialog: null,
    console: [],
    network: new Map(),
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
  pages.set(current.owner, current);
}

async function ensurePage(cdp, signal, targetId, owner = currentOwner()) {
  const listed = await cdp.send("Target.getTargets", { dshOwner: owner }, undefined, signal);
  const pages = (listed.targetInfos || []).filter(isControllablePage);
  let target = targetId ? pages.find((page) => page.targetId === targetId) : pages[0];
  if (targetId && !target) throw new Error("target_id does not belong to this conversation or is no longer available");
  if (!target) {
    const created = await cdp.send("Target.createTarget", { url: "about:blank", dshOwner: owner }, undefined, signal);
    target = { targetId: created.targetId };
  }
  const attached = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true, dshOwner: owner }, undefined, signal);
  const sessionId = attached.sessionId;
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId, signal);
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

const REF_WORLD = "dsh-chrome-refs";

function refMaps(current) {
  if (!current.refWorlds) current.refWorlds = new Map();
  if (!current.refWorldIds) current.refWorldIds = new Set();
  if (!current.refWorldFrames) current.refWorldFrames = new Map();
  return current;
}

async function mainFrameId(current, signal) {
  if (current.mainFrameId) return current.mainFrameId;
  const tree = await current.cdp.send("Page.getFrameTree", {}, current.sessionId, signal);
  const id = tree?.frameTree?.frame?.id;
  if (!id) throw new Error("page frame is not available");
  current.mainFrameId = id;
  return id;
}

async function ensureRefWorld(current, frameId, signal) {
  if (!frameId) throw new Error("isolated world frame is not available");
  refMaps(current);
  const cached = current.refWorlds.get(frameId);
  if (cached) return cached;
  const created = await current.cdp.send("Page.createIsolatedWorld", {
    frameId,
    worldName: REF_WORLD,
    grantUniveralAccess: true,
  }, current.sessionId, signal);
  const contextId = created?.executionContextId;
  if (!contextId) throw new Error("isolated world was not created");
  current.refWorlds.set(frameId, contextId);
  current.refWorldIds.add(contextId);
  current.refWorldFrames.set(contextId, frameId);
  return contextId;
}

async function refWorldFor(current, owner, signal) {
  refMaps(current);
  if (owner?.contextId && current.refWorldIds.has(owner.contextId)) return owner.contextId;
  let frameId = owner?.frameId || "";
  const pageContext = owner?.pageContextId || (owner?.contextId && current.contexts?.has(owner.contextId) ? owner.contextId : undefined);
  if (!frameId && pageContext) frameId = current.contexts?.get(pageContext)?.frameId || "";
  if (!frameId) frameId = await mainFrameId(current, signal);
  return ensureRefWorld(current, frameId, signal);
}

function pageContextFor(current, owner) {
  if (!owner) return undefined;
  if (owner.pageContextId && current.contexts?.has(owner.pageContextId)) return owner.pageContextId;
  if (owner.contextId && current.contexts?.has(owner.contextId)) return owner.contextId;
  return undefined;
}

function invalidateRefWorld(current, frameId, isMain) {
  refMaps(current);
  const contextId = current.refWorlds.get(frameId);
  current.refWorlds.delete(frameId);
  if (contextId) {
    current.refWorldIds.delete(contextId);
    current.refWorldFrames.delete(contextId);
  }
  if (isMain) current.mainFrameId = frameId;
  if (current.refOwners) {
    for (const [ref, owner] of current.refOwners) {
      if (owner.frameId === frameId || owner.contextId === contextId) current.refOwners.delete(ref);
    }
  }
  current.refsStale = true;
  const generation = (current.refGeneration || 0) + 1;
  current.refGeneration = generation;
  current.refCollect = Promise.resolve().then(async () => {
    if (current.refGeneration !== generation) return;
    const world = await ensureRefWorld(current, frameId);
    await evaluateIn(current.cdp, current.sessionId, SNAPSHOT_SCRIPT, world, undefined, 4000);
    current.refsStale = false;
  }).catch(() => {});
}

async function evaluateMainRefs(current, expression, signal, timeoutMs) {
  const frameId = await mainFrameId(current, signal);
  const world = await ensureRefWorld(current, frameId, signal);
  return evaluateIn(current.cdp, current.sessionId, expression, world, signal, timeoutMs);
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
      frameId: frame.id,
      pageContextId: context.id,
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
      frameId: meta.frameId,
      pageContextId: meta.pageContextId,
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
      const world = await ensureRefWorld(current, frame.frameId, signal);
      const value = await evaluateIn(current.cdp, current.sessionId, scriptFor(), world, signal, 4000);
      if (!value || value.ok === false) continue;
      found.push(...adoptFrameElements(current, value.elements, { ...frame, contextId: world }));
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
  const contextId = await refWorldFor(current, owner, signal);
  return evaluateIn(current.cdp, current.sessionId, scriptFor(owner?.localRef ?? ref), contextId, signal);
}

async function remoteOwned(current, ref, scriptFor, signal) {
  const owner = owned(current, ref);
  const contextId = await refWorldFor(current, owner, signal);
  const params = { expression: scriptFor(owner?.localRef ?? ref), returnByValue: false, awaitPromise: true, contextId };
  const remote = await current.cdp.send("Runtime.evaluate", params, current.sessionId, signal);
  if (remote.exceptionDetails) throw new Error(remote.exceptionDetails.exception?.description || remote.exceptionDetails.text || "ref not found");
  if (!remote.result?.objectId) throw new Error("ref not found");
  return remote.result.objectId;
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
    const value = await evaluateMainRefs(current, SNAPSHOT_SCRIPT, signal, 4000);
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
      await current.cdp.send("Target.closeTarget", { targetId: id, dshOwner: current.owner }, undefined, active);
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
    return formatText(ref == null
      ? await readPage(current, textScript(selector, null), signal)
      : await evalOwned(current, ref, (local) => textScript("", local), signal));
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
    const value = await evaluateMainRefs(current, queryScript(wanted, count), active);
    if (!value || value.ok === false) throw new Error(value?.error || "page read failed");
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
  return exclusive(async (active) => {
    const current = await ensure(active);
    let value;
    if (index == null) {
      value = await evaluate(current.cdp, current.sessionId, source, active);
    } else {
      const owner = owned(current, index);
      const world = await refWorldFor(current, owner, active);
      const local = owner?.localRef ?? index;
      const remote = await current.cdp.send("Runtime.evaluate", {
        expression: `(() => { const element = window.__dshRefs && window.__dshRefs[${local}]; if (!element || !element.isConnected) throw new Error("ref not found"); return element; })()`,
        returnByValue: false,
        awaitPromise: true,
        contextId: world,
      }, current.sessionId, active);
      if (remote.exceptionDetails) throw new Error(remote.exceptionDetails.exception?.description || remote.exceptionDetails.text || "ref not found");
      const isolatedId = remote.result?.objectId;
      if (!isolatedId) throw new Error("ref not found");
      let pageObjectId = "";
      try {
        const described = await current.cdp.send("DOM.describeNode", { objectId: isolatedId }, current.sessionId, active);
        const backendNodeId = described.node?.backendNodeId;
        if (!backendNodeId) throw new Error("ref not found");
        const pageContext = pageContextFor(current, owner);
        const resolved = await current.cdp.send("DOM.resolveNode", {
          backendNodeId,
          ...(pageContext ? { executionContextId: pageContext } : {}),
        }, current.sessionId, active);
        pageObjectId = resolved.object?.objectId || "";
        if (!pageObjectId) throw new Error("ref not found");
        const called = await current.cdp.send("Runtime.callFunctionOn", {
          objectId: pageObjectId,
          functionDeclaration: `function() { const element = this; return (${source}); }`,
          returnByValue: true,
        }, current.sessionId, active);
        if (called.exceptionDetails) throw new Error(called.exceptionDetails.exception?.description || called.exceptionDetails.text || "page script failed");
        value = called.result?.value;
      } finally {
        await current.cdp.send("Runtime.releaseObject", { objectId: isolatedId }, current.sessionId, active).catch(() => {});
        if (pageObjectId) await current.cdp.send("Runtime.releaseObject", { objectId: pageObjectId }, current.sessionId, active).catch(() => {});
      }
    }
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
    for (let i = 0; i < files.length; i += 1) files[i] = await assertBrowserPath(files[i], "read");
    const objectId = await remoteOwned(current, index, fileInputScript, signal);
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
    const requestedDest = requested
      ? (path.isAbsolute(requested) ? requested : path.join(options.cwd || dir, requested))
      : path.join(dir, screenshotName());
    const dest = await writeBrowserFile(requestedDest, bytes);
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
    const listed = await current.cdp.send("Browser.getDownloadItems", { dshOwner: current.owner }, undefined, active);
    if (!listed || !Array.isArray(listed.items)) throw new Error("invalid Chrome download response: items must be an array");
    return formatDownloads(listed.items, "current Chrome download folder");
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
async function bindAxRef(current, backendNodeId, contextId, stage, signal) {
  const params = { backendNodeId };
  if (contextId) params.executionContextId = contextId;
  const resolved = await current.cdp.send("DOM.resolveNode", params, current.sessionId, signal);
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("accessibility node could not be resolved");
  try {
    const called = await current.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() {
        if (!this || this.nodeType !== 1) return null;
        var refs = window[${JSON.stringify(stage)}];
        if (!refs) throw new Error("accessibility context changed");
        var ref = refs.length;
        refs.push(this);
        return { ref: ref, password: this.tagName === "INPUT" && String(this.getAttribute("type") || "").toLowerCase() === "password", safeName: this.getAttribute("aria-label") || this.getAttribute("placeholder") || this.getAttribute("name") || "" };
      }`,
      returnByValue: true,
    }, current.sessionId, signal);
    if (called.exceptionDetails) throw new Error(called.exceptionDetails.text || "accessibility binding failed");
    return called.result?.value ?? null;
  } finally {
    await current.cdp.send("Runtime.releaseObject", { objectId }, current.sessionId).catch(() => {});
  }
}

async function computedA11y(current, spec, signal) {
  const scope = spec.ref == null ? null : owned(current, spec.ref);
  const pageContextId = pageContextFor(current, scope);
  const tree = await current.cdp.send("Page.getFrameTree", {}, current.sessionId, signal);
  let frameId = scope?.frameId || (pageContextId && current.contexts?.get(pageContextId)?.frameId) || "";
  if (!frameId) frameId = tree.frameTree?.frame?.id;
  const contextId = await ensureRefWorld(current, frameId, signal);
  let rootBackend;
  if (spec.ref != null) {
    const objectId = await remoteOwned(current, spec.ref, (local) => `(() => { const el = window.__dshRefs?.[${local}]; if (!el?.isConnected) throw new Error("ref not found"); return el; })()`, signal);
    try {
      rootBackend = (await current.cdp.send("DOM.describeNode", { objectId }, current.sessionId, signal)).node?.backendNodeId;
      if (!rootBackend) throw new Error("accessibility subtree root not found");
    } finally {
      await current.cdp.send("Runtime.releaseObject", { objectId }, current.sessionId).catch(() => {});
    }
  }
  await current.cdp.send("Accessibility.enable", {}, current.sessionId, signal);
  const listed = await current.cdp.send("Accessibility.getFullAXTree", frameId ? { frameId } : {}, current.sessionId, signal);
  let nodes = listed.nodes || [];
  if (rootBackend) {
    const root = nodes.find((node) => node.backendDOMNodeId === rootBackend);
    if (!root) throw new Error("accessibility subtree root not found");
    const included = new Set([String(root.nodeId)]);
    for (let changed = true; changed;) {
      changed = false;
      for (const node of nodes) if (!included.has(String(node.nodeId)) && included.has(String(node.parentId))) {
        included.add(String(node.nodeId)); changed = true;
      }
    }
    nodes = nodes.filter((node) => included.has(String(node.nodeId)));
  }
  const stage = `__dshAxStage_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await evaluateIn(current.cdp, current.sessionId, `window[${JSON.stringify(stage)}] = []; true`, contextId, signal);
  const owners = new Map();
  let bound = 0;
  try {
    for (const node of nodes) {
      if (bound >= 80 || node.ignored || !node.backendDOMNodeId) continue;
      const role = String(node.role?.value || "");
      if (!/button|link|textbox|searchbox|combobox|checkbox|radio|tab|menuitem|switch|slider|option|heading|image/i.test(role)) continue;
      const binding = await bindAxRef(current, node.backendDOMNodeId, contextId, stage, signal);
      if (binding?.ref == null) continue;
      node.ref = binding.ref;
      if (binding.password) { node.value = { value: "[redacted]" }; node.name = { value: binding.safeName || "" }; }
      if (scope || contextId) owners.set(node.ref, { url: scope?.url, crossOrigin: scope?.crossOrigin, offset: scope?.offset, contextId, frameId, pageContextId, localRef: binding.ref });
      bound += 1;
    }
    const output = formatComputedA11y({ filter: spec.filter, nodes, depth: spec.depth });
    await evaluateIn(current.cdp, current.sessionId, `window.__dshRefs = window[${JSON.stringify(stage)}]; delete window[${JSON.stringify(stage)}]; true`, contextId, signal);
    current.refOwners = owners;
    current.nextRef = bound;
    return output;
  } finally {
    await evaluateIn(current.cdp, current.sessionId, `delete window[${JSON.stringify(stage)}]`, contextId).catch(() => {});
  }
}

export function a11y(options = {}) {
  const spec = assertA11y(options);
  return exclusive(async (signal) => {
    const current = await ensure(signal);
    if (current.pendingDialog) return blockedObservation(current);
    try {
      return await computedA11y(current, spec, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const scope = spec.ref == null ? null : owned(current, spec.ref);
      const world = await refWorldFor(current, scope, signal);
      const pageContextId = pageContextFor(current, scope);
      const frameId = scope?.frameId || (pageContextId && current.contexts?.get(pageContextId)?.frameId) || current.mainFrameId;
      const value = spec.ref == null
        ? await evaluateIn(current.cdp, current.sessionId, a11yScript(spec), world, signal)
        : await evaluateIn(current.cdp, current.sessionId, a11yScript({ ...spec, ref: scope?.localRef ?? spec.ref }), world, signal);
      if (!value?.ok) throw new Error(value?.error || "accessibility read failed");
      const owners = new Map();
      let count = 0;
      const visit = (nodes) => { for (const node of nodes || []) { count = Math.max(count, node.ref + 1); owners.set(node.ref, { contextId: world, frameId, pageContextId, localRef: node.ref, url: scope?.url, crossOrigin: scope?.crossOrigin, offset: scope?.offset }); visit(node.children); } };
      visit(value.tree);
      current.refOwners = owners;
      current.nextRef = count;
      return `${formatA11y(value)}\nsource: dom-fallback (accessibility-tree unavailable)`;
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
    const value = await evaluateMainRefs(current, findScript(text, FIND_LIMIT), active);
    if (!value || value.ok === false) throw new Error(value?.error || "page read failed");
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
    const results = [];
    for (const item of items) {
      const value = await evalOwned(current, item.ref, (local) => fillScript([{ ...item, ref: local }]), active);
      results.push({ ...(value?.results?.[0] || { ok: false, error: "field was not filled" }), ref: item.ref });
    }
    const summary = formatFill({ ok: results.every((item) => item.ok), results });
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

async function readShortcuts(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.create(null);
    throw error;
  }
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error("invalid shortcut store JSON; existing file was not overwritten", { cause: error }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid shortcut store: expected an object of named action arrays");
  }
  const stored = Object.create(null);
  for (const [name, actions] of Object.entries(value)) {
    if (!name.trim() || name !== name.trim()) throw new Error("invalid shortcut store: names must be non-empty and trimmed");
    try { stored[name] = assertBatch(actions); }
    catch (error) { throw new Error("invalid shortcut store action array; existing file was not overwritten", { cause: error }); }
  }
  return stored;
}

async function saveShortcut(file, name, actions, signal) {
  // Inspect before creating any files; re-read under the cross-process lock.
  await readShortcuts(file);
  if (signal?.aborted) throw new Error("cancelled");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockFile = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let lock;
  while (!lock) {
    if (signal?.aborted) throw new Error("cancelled");
    try { lock = await open(lockFile, "wx", 0o600); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("shortcut store is busy; lock was not removed (check other writers before clearing a stale lock)");
      await delay(25, signal);
    }
  }
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  let tempCreated = false;
  try {
    const stored = await readShortcuts(file);
    stored[name] = actions;
    if (signal?.aborted) throw new Error("cancelled");
    handle = await open(temp, "wx", 0o600);
    tempCreated = true;
    await handle.writeFile(JSON.stringify(stored, null, 2));
    await handle.sync();
    await handle.close();
    handle = null;
    if (signal?.aborted) throw new Error("cancelled");
    await rename(temp, file);
    tempCreated = false;
  } finally {
    // Only remove paths created by this writer; never steal another writer's lock.
    try {
      try { if (handle) await handle.close(); }
      finally { if (tempCreated) await unlink(temp); }
    } finally {
      try { await lock.close(); }
      finally { await unlink(lockFile); }
    }
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
    const screenshotPath = await assertBrowserPath(current.lastShot, "read");
    if (options.ref != null && options.ref !== "") {
      const files = [screenshotPath];
      const index = assertRef(options.ref);
      const objectId = await remoteOwned(current, index, fileInputScript, signal);
      try {
        await current.cdp.send("DOM.setFileInputFiles", { files, objectId }, current.sessionId, signal);
      } finally {
        await current.cdp.send("Runtime.releaseObject", { objectId }, current.sessionId).catch(() => {});
      }
      return observe(current, signal);
    }
    const at = assertPoint(options.x, options.y);
    const frameId = await mainFrameId(current, signal);
    const world = await ensureRefWorld(current, frameId, signal);
    const found = await evaluateIn(current.cdp, current.sessionId, `(() => {
      const el = document.elementFromPoint(${at.x}, ${at.y});
      if (!el) return { ok: false, error: "no element at that point" };
      const input = el.closest && el.closest("input[type=file]") || (el.matches && el.matches("input[type=file]") ? el : null);
      if (!input) return { ok: false, error: "point is not a file input" };
      if (!window.__dshRefs) window.__dshRefs = [];
      const ref = window.__dshRefs.length;
      window.__dshRefs.push(input);
      return { ok: true, ref };
    })()`, world, signal);
    if (!found?.ok) {
      const shot = await readBrowserFile(screenshotPath);
      await current.cdp.send("Input.setInterceptDrags", { enabled: true }, current.sessionId, signal);
      const data = { items: [{ mimeType: "image/png", data: shot.toString("base64") }], dragOperationsMask: 1 };
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await current.cdp.send("Input.dispatchDragEvent", { type, x: at.x, y: at.y, data }, current.sessionId, signal);
      }
      return `drop attempted at ${at.x},${at.y}. File inputs are reliable; coordinate drops only work if the page accepts a drag. Last screenshot: ${current.lastShot}`;
    }
    const files = [screenshotPath];
    const remote = await current.cdp.send("Runtime.evaluate", {
      expression: fileInputScript(found.ref),
      returnByValue: false,
      contextId: world,
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
        const cookies = (listed.cookies || [])
          .filter((cookie) => !name || cookie.name === name)
          .map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            httpOnly: cookie.httpOnly === true,
          }));
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
    const stamp = `${screenshotName().replace(/\.png$/, "")}-${randomUUID()}`;
    const frameDir = path.join(dir, stamp);
    for (let index = 0; index < frames.length; index += 1) {
      await writeBrowserFile(path.join(frameDir, `frame-${String(index).padStart(3, "0")}.png`), frames[index]);
    }
    const dest = path.join(dir, `${stamp}.gif`);
    let encoder = "";
    for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
      try {
        await access(candidate, constants.X_OK);
        encoder = candidate;
        break;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      }
    }
    if (!encoder) return `saved frames ${frameDir}\nffmpeg was not found, so no gif was encoded.`;
    await assertBrowserPath(dest, "write");
    const bytes = await new Promise((resolve, reject) => {
      const child = spawn(encoder, [
        "-n", "-framerate", "2", "-i", path.join(frameDir, "frame-%03d.png"),
        "-vf", "scale=800:-1:flags=lanczos", "-f", "gif", "pipe:1",
      ], { stdio: ["ignore", "pipe", "ignore"], signal });
      const chunks = [];
      let length = 0;
      child.stdout.on("data", (chunk) => {
        length += chunk.length;
        if (length > 48 * 1024 * 1024) { child.kill(); reject(new Error("encoded GIF exceeds 48 MiB")); }
        else chunks.push(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => code === 0 && length > 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}; no GIF saved`)));
    });
    const saved = await writeBrowserFile(dest, bytes);
    return `saved ${saved}\nframes: ${frames.length}`;
  }, options.signal);
}

/**
 * @param {{ action?: unknown, name?: unknown, actions?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<string>}
 */
export async function shortcut(options = {}) {
  const action = String(options.action || "list");
  if (!["list", "save", "run"].includes(action)) throw new Error("action must be list, save, or run");
  if (options.signal?.aborted) throw new Error("cancelled");
  const file = shortcutFile();
  if (action === "list") {
    const stored = await readShortcuts(file);
    const names = Object.keys(stored);
    return names.length ? names.map((name) => `${name} (${stored[name].length} steps)`).join("\n") : "(none)";
  }
  const name = String(options.name || "").trim();
  if (!name) throw new Error("name is required");
  if (action === "save") {
    await saveShortcut(file, name, assertBatch(options.actions), options.signal);
    return `saved shortcut ${name}`;
  }
  const stored = await readShortcuts(file);
  if (!Object.hasOwn(stored, name)) throw new Error(`shortcut not found: ${name}`);
  return batch(stored[name], options.signal);
}

/**
 * @param {unknown} action
 * @param {unknown} _port
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<string>}
 */
export function browsers(action, _port, signal) {
  const name = String(action || "list");
  if (name !== "list") {
    throw new Error("This build controls the current Chrome through the DSH extension. It does not attach to a debug port.");
  }
  const owner = currentOwner();
  const execution = extensionExecution(owner);
  return exclusive(async (active) => {
    const connection = await ensureBridge(active);
    try {
      const hello = await connection.send("DSH.hello", {}, undefined, active, 2500);
      if (!hello.ok || hello.protocolVersion !== 2) {
        throw new Error("DSH Chrome extension needs bridge protocol 2. Reload the extension.");
      }
      connection.engine = validateExtensionEngine(execution, hello.engine);
    } catch (error) {
      // A failed probe is not permission to disconnect another owner's work.
      const otherUsers = [...ownerTails.keys()].some(key => key !== owner)
        || [...pages].some(([key, page]) => key !== owner && page.cdp === connection)
        || [...captureSessions.values()].some(lease => lease.originOwner !== owner && lease.connection === connection);
      if (!active?.aborted && !otherUsers) {
        connection.close();
        if (bridge === connection) {
          bridge = null;
          pages.clear();
        }
      }
      throw error;
    }
    const retained = [...ownerCleanups.values()].filter(record => record.state === "retained" && (record.owner === owner || record.originOwner === owner));
    const unknown = retained.flatMap(record => record.unconfirmedCreates || []);
    return [
      "mode: current Chrome extension",
      "execution: headed / borrowed-connection (not headless)",
      `adapter version: ${browserExecutionVersions.adapter}`,
      `extension version: ${connection.engine.extensionVersion}`,
      `required extension version: ${browserExecutionVersions.extension}`,
      `policy version: ${browserExecutionVersions.policy}`,
      `policy source: ${browserExecutionVersions.policySourceSha256}`,
      `browser version: ${connection.engine?.browserVersion || "unavailable; reload the extension for engine metadata"}`,
      `group: ${groupTitle(currentOwner())}`,
      "focus: background tabs, Chrome is not activated",
      `conversations: ${pages.size}`,
      `pending cleanup owners: ${retained.map(record => record.owner).join(", ") || "none"}`,
      ...(unknown.length ? [`unconfirmed create diagnostics: ${JSON.stringify(unknown)}`] : []),
      "bridge: connected",
    ].join("\n");
  }, signal);
}

function cleanupPending(error) {
  return Object.assign(new Error(`Chrome cleanup is unconfirmed; ownership is retained for an explicit retry: ${error?.message || error}`), { code: "CHROME_CLEANUP_PENDING", ...(error instanceof Error ? { cause: error } : {}) });
}

async function settleOwner(record) {
  record.state = "closing";
  record.error = undefined;
  ownerCleanups.set(record.owner, record);
  try {
    const connection = record.connection;
    if (!connection || connection.closed) throw new Error("Chrome connection closed before cleanup acknowledgement");
    if (connection.engine?.extensionVersion !== browserExecutionVersions.extension) {
      throw Object.assign(new Error(`Chrome cleanup requires the loaded adapter's extension ${browserExecutionVersions.extension}; actual worker is ${connection.engine?.extensionVersion || "unavailable"}`), { code: "CHROME_EXTENSION_VERSION_MISMATCH" });
    }
    try {
      await connection.settleCreates(record.owner, 3000);
    } catch (error) {
      // A bounded local wait is not settlement. Still dispatch the authoritative
      // worker close barrier; only its actual ACK can prove this owner drained.
      record.creationWaitError = error.message;
    }
    if (connection.closed) throw new Error("Chrome connection closed before cleanup acknowledgement");
    await connection.send("Browser.close", { dshOwner: record.owner }, undefined, undefined, 3000);
    pages.delete(record.owner); // The ACK proves known own targets are now gone.
    const unknown = (unconfirmedCreates.get(record.owner) || []).filter(item =>
      typeof item.workerGeneration !== "string" || !item.workerGeneration || item.workerGeneration !== connection.engine?.workerGeneration);
    record.unconfirmedCreates = unknown;
    if (unknown.length) {
      unconfirmedCreates.set(record.owner, unknown);
      throw new Error(`Worker generation changed or is unavailable for unacknowledged create request(s) ${unknown.map(item => `${item.connection}:${item.requestId}`).join(", ")}; known owner targets were closed, but unknown creation remains retained`);
    }
    unconfirmedCreates.delete(record.owner);
    record.state = "closed";
    if (ownerCleanups.get(record.owner) === record) ownerCleanups.delete(record.owner);
  } catch (error) {
    record.state = "retained";
    record.error = error?.message || String(error);
    throw cleanupPending(error);
  }
}

/**
 * Hold the extension bridge and return a CDP adapter for one capture.
 * Does not open a second socket and does not replace the conversation's current tab.
 * @param {AbortSignal | undefined} signal
 * @param {{execution?: object, operationCwd?: string}} [options] Internal caller context, never tool-supplied ownership.
 */
export async function openCaptureSession(signal, options = {}) {
  const execution = extensionExecution(currentOwner(), options.execution);
  const owner = `capture:${execution.scope.sessionId}:${randomUUID()}`;
  const lease = { owner, originOwner: execution.scope.sessionId, scope: execution.scope, state: "queued", connection: null };
  let grant;
  let fail;
  let close;
  const ready = new Promise((resolve, reject) => {
    grant = resolve;
    fail = reject;
  });
  const onAbort = () => {
    fail(new Error("cancelled"));
    // Connection loss is retained, not permission for an automatic reconnect.
    if (!lease.connection?.closed) close?.().catch(fail);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  exclusive(async (active) => {
    const connection = await ensureBridge(active);
    if (active?.aborted) throw new Error("cancelled");
    const engine = validateExtensionEngine(execution, connection.engine);
    lease.connection = connection;
    lease.state = "open";
    captureSessions.set(owner, lease);
    const lifetime = new AbortController();
    const listeners = new Set();
    let closed = false;
    let closing;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const ensureOpen = () => {
      if (closed) throw new Error("Chrome capture session closed");
    };
    const stop = () => {
      closed = true;
      lifetime.abort();
      for (const listener of listeners) connection.listeners.delete(listener);
      listeners.clear();
    };
    close = () => {
      if (closing) return closing;
      if (lease.state === "closed") return Promise.resolve();
      stop();
      if (lease.connection.closed && !lease.lossReported) {
        lease.lossReported = true;
        lease.state = "retained";
        lease.error ||= "Chrome connection closed before owner cleanup acknowledgement";
        ownerCleanups.set(owner, lease);
        finish();
        return Promise.reject(cleanupPending(lease.error));
      }
      const attempt = (async () => {
        try {
          // Only an explicit close retry reconnects a lost bridge, always with
          // the exact retained capture owner and a validated actual engine.
          if (lease.connection.closed) {
            lease.connection = await ensureBridge();
            validateExtensionEngine(execution, lease.connection.engine);
          }
          await settleOwner(lease);
          captureSessions.delete(owner);
          resourceActivity.delete(owner);
        } catch (error) {
          lease.state = "retained";
          lease.error = error?.message || String(error);
          if (lease.connection.closed) lease.lossReported = true;
          ownerCleanups.set(owner, lease);
          throw cleanupPending(error);
        } finally {
          finish(); // A failed cleanup releases only its parent's queue.
        }
      })();
      closing = attempt;
      attempt.then(() => {}, () => { if (closing === attempt) closing = undefined; });
      return attempt;
    };
    const disconnected = (event) => {
      if (event.method !== "DSH.connectionClosed") return;
      stop();
      lease.state = "retained";
      lease.error = "Chrome connection closed; no owner cleanup acknowledgement was received";
      ownerCleanups.set(owner, lease);
      finish();
    };
    connection.listeners.add(disconnected);
    listeners.add(disconnected);
    const commandSignal = (extra) => extra ? AbortSignal.any([lifetime.signal, extra]) : lifetime.signal;
    const ownsEvent = event => connection.sessionOwners.get(event.sessionId || event.params?.sessionId || event.params?.targetId) === owner;
    const cdp = {
      onEvent(listener) {
        ensureOpen();
        const scoped = event => { if (ownsEvent(event)) listener(event); };
        connection.listeners.add(scoped);
        listeners.add(scoped);
        return () => { connection.listeners.delete(scoped); listeners.delete(scoped); };
      },
      waitForEvent(method, opts = {}) {
        try { ensureOpen(); } catch (error) { return Promise.reject(error); }
        return connection.waitFor(method, opts.sessionId, (_params, event) => ownsEvent(event), opts.timeoutMs || 30_000, commandSignal(opts.signal));
      },
      send(method, params = {}, sessionId, opts = {}) {
        try { ensureOpen(); } catch (error) { return Promise.reject(error); }
        if (opts.signal?.aborted) return Promise.reject(new Error("cancelled"));
        return connection.send(method, { ...(params || {}), dshOwner: owner }, sessionId,
          method === "Target.createTarget" ? undefined : commandSignal(opts.signal), opts.timeoutMs || 30_000);
      },
      close,
    };
    grant({
      mode: "extension",
      backend: "chrome-extension",
      versions: browserExecutionVersions,
      execution,
      engine,
      cdp,
      child: null,
      profile: "",
      userAgent: "",
      get cleanup() { return Object.freeze({ owner, state: lease.state, ...(lease.error ? { error: lease.error } : {}),
        ...(lease.unconfirmedCreates?.length ? { unconfirmedCreates: Object.freeze([...lease.unconfirmedCreates]) } : {}) }); },
      close,
    });
    await done;
  }, signal, lease).catch(fail).finally(() => signal?.removeEventListener("abort", onAbort));
  return ready;
}

export function closeBrowser(signal) {
  return exclusive(async () => {
    await shutdown();
    return "closed this conversation's DSH tab group. Other conversations and Chrome stay open.";
  }, signal);
}

/** Close the DSH tab group. Does not quit Chrome. */
export async function shutdown() {
  const owner = currentOwner();
  const cdp = await ensureBridge();
  await settleOwner({ owner, connection: cdp, state: "open" });
  const otherWork = [...ownerTails.keys()].some(key => key !== owner);
  if (pages.size === 0 && captureSessions.size === 0 && !otherWork && bridge === cdp) {
    cdp.close();
    bridge = null;
  }
}

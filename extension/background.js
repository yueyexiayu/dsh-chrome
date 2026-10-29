import { GROUP_TITLE, HOST_NAME, OWNERSHIP_KEY, canPick, groupTitle, ignoreFocusMethod, requireOwner, tabCreateProperties } from "./policy.js";
import { jpegBoxes } from "./shot.js";

const sessions = new Map();
const tabOwners = new Map();
const pendingMarks = new Map();
// These are actual worker operations, not caller promises which may time out.
const ownerOperations = new Map();
const closingOwners = new Map();
// Instance identity only: never a permission token or alternate admission path.
const workerGeneration = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
let ownersReady = null;
let ownersSaved = Promise.resolve();
let port = null;
let reconnectTimer = null;
let bridgeConflict = false;
const conflictReady = chrome.storage.session.get("dsh-bridge-conflict").then(stored => {
  bridgeConflict = Boolean(stored["dsh-bridge-conflict"]);
});

function sessionIdFor(tabId) {
  return `tab-${tabId}`;
}

function tabIdFrom(targetId) {
  const match = /^tab-(\d+)$/.exec(String(targetId || ""));
  if (!match) throw new Error(`unknown target ${targetId}`);
  return Number(match[1]);
}

function post(message) {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch {
    // The host will reconnect on the next Chrome spawn.
  }
}

function postEvent(message) {
  post(message);
}

function ownerOf(params) {
  return requireOwner(params?.dshOwner);
}

function loadOwners() {
  if (!ownersReady) ownersReady = chrome.storage.session.get(OWNERSHIP_KEY).then((stored) => {
    for (const entry of stored[OWNERSHIP_KEY] || []) {
      if (Array.isArray(entry) && Number.isInteger(entry[0]) && typeof entry[1] === "string" && entry[1].trim()) {
        tabOwners.set(entry[0], entry[1]);
      }
    }
  });
  return ownersReady;
}

function saveOwners() {
  const saved = ownersSaved.catch(() => {}).then(() => chrome.storage.session.set({ [OWNERSHIP_KEY]: [...tabOwners] }));
  ownersSaved = saved;
  return saved;
}

async function ownedTab(tabId, owner) {
  await loadOwners();
  if (tabOwners.get(tabId) !== owner) throw new Error(`tab ${tabId} does not belong to this DSH conversation`);
  return chrome.tabs.get(tabId);
}

async function groupTab(tabId, windowId, owner) {
  await loadOwners();
  const title = groupTitle(owner);
  const tabs = await chrome.tabs.query({ windowId });
  const existing = tabs.find((tab) => tab.groupId >= 0 && tabOwners.get(tab.id) === owner
    && tabs.filter((item) => item.groupId === tab.groupId).every((item) => tabOwners.get(item.id) === owner));
  if (existing) {
    await chrome.tabs.group({ groupId: existing.groupId, tabIds: tabId });
    return existing.groupId;
  }
  const groupId = await chrome.tabs.group({
    tabIds: tabId,
    createProperties: { windowId },
  });
  await chrome.tabGroups.update(groupId, { title, color: "blue", collapsed: true });
  return groupId;
}

async function attachTab(tabId, owner) {
  await ownedTab(tabId, owner);
  const sessionId = sessionIdFor(tabId);
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already attached/i.test(message)) throw error;
  }
  sessions.set(sessionId, tabId);
  return { sessionId, targetId: sessionId };
}

function assertOwnerOpen(owner) {
  if (closingOwners.has(owner)) {
    throw Object.assign(new Error("This DSH owner is closing; wait for actual cleanup settlement before starting new work"), { code: "CHROME_OWNER_CLOSING" });
  }
}

function ownerOperation(owner, method, work) {
  assertOwnerOpen(owner);
  let operations = ownerOperations.get(owner);
  if (!operations) ownerOperations.set(owner, operations = new Set());
  const operation = Promise.resolve().then(work);
  const entry = { method, operation };
  operations.add(entry); // Register synchronously, before dispatch or an await.
  const settled = () => {
    operations.delete(entry);
    if (!operations.size && ownerOperations.get(owner) === operations) ownerOperations.delete(owner);
  };
  operation.then(settled, settled);
  return operation;
}

async function removeTabs(ids) {
  const removal = chrome.tabs.remove(ids);
  if (!removal || typeof removal.then !== "function") {
    throw Object.assign(new Error("Chrome tab removal has no settlement promise; ownership is retained for an explicit cleanup retry"), { code: "CHROME_CLEANUP_PENDING" });
  }
  await removal;
}

async function createTarget(url, owner) {
  assertOwnerOpen(owner);
  await loadOwners();
  assertOwnerOpen(owner);
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  assertOwnerOpen(owner); // A cancelled preflight must not dispatch a later create.
  const focused = wins.find((win) => win.focused) || wins[0];
  if (!focused) {
    throw Object.assign(new Error("Chrome has no normal window. Background-tab control never creates a GUI window; explicitly open Chrome normally before borrowing it."), { code: "CHROME_NORMAL_WINDOW_REQUIRED" });
  }
  const tab = await chrome.tabs.create(tabCreateProperties(focused.id, url));
  if (tab.id == null) throw new Error("Chrome did not return a tab id");
  tab.windowId ??= focused.id;
  // An actual resource belongs to its creator even if grouping/storage fails.
  // Persist before grouping, so a restarted worker can clean up the exact child.
  tabOwners.set(tab.id, owner);
  try {
    await saveOwners();
    assertOwnerOpen(owner);
    await groupTab(tab.id, tab.windowId, owner);
    assertOwnerOpen(owner);
  } catch (error) {
    try {
      await removeTabs(tab.id);
      tabOwners.delete(tab.id);
      await saveOwners();
    } catch (cleanupError) {
      tabOwners.set(tab.id, owner);
      throw Object.assign(new Error(`Chrome target ${sessionIdFor(tab.id)} initialization failed (${error.message}); cleanup/persistence is unconfirmed and ownership record retained: ${cleanupError.message}`), { code: "CHROME_CLEANUP_PENDING", cause: cleanupError });
    }
    throw error;
  }
  return { targetId: sessionIdFor(tab.id) };
}

async function listAgentTabs(owner) {
  await loadOwners();
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id != null && tabOwners.get(tab.id) === owner);
}

async function closeKnownTabs(owner) {
  await loadOwners();
  const recorded = [...tabOwners].filter(([, actualOwner]) => actualOwner === owner);
  const tabs = await listAgentTabs(owner);
  const ids = tabs.map((tab) => tab.id).filter((id) => id != null);
  const detachments = ids.map(async (tabId) => {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Successful actual tab removal also disposes an already-detached debugger.
    } finally {
      sessions.delete(sessionIdFor(tabId));
    }
  });
  // Dispatch removal before waiting on commands/detach: evaluate(await forever)
  // can settle only because its own target is interrupted or removed.
  try {
    if (ids.length) await removeTabs(ids);
  } finally {
    await Promise.all(detachments);
  }
  for (const [id] of recorded) tabOwners.delete(id);
  try {
    await saveOwners();
  } catch (error) {
    for (const [id, actualOwner] of recorded) tabOwners.set(id, actualOwner);
    throw error;
  }
}

function closeAgentTabs(owner) {
  if (closingOwners.has(owner)) return closingOwners.get(owner);
  const accepted = [...(ownerOperations.get(owner) || [])];
  const closing = (async () => {
    try {
      // First interrupt known own targets, rather than deadlock waiting for a
      // command whose settlement requires exactly that interruption.
      await closeKnownTabs(owner);
      // A create already dispatched to Chrome can still return an actual ID.
      // Retain/clean that exact child before the owner close can acknowledge.
      await Promise.allSettled(accepted.filter(entry => entry.method === "Target.createTarget").map(entry => entry.operation));
      await closeKnownTabs(owner);
      await Promise.allSettled(accepted.map(entry => entry.operation));
      await saveOwners();
      return {};
    } catch (error) {
      // Failure must not release this owner while previously accepted RPCs live.
      await Promise.allSettled(accepted.map(entry => entry.operation));
      throw Object.assign(new Error(`Chrome owner cleanup is unconfirmed; retained ownership permits an explicit retry: ${error.message}`), { code: "CHROME_CLEANUP_PENDING", cause: error });
    }
  })();
  closingOwners.set(owner, closing); // Freeze this owner synchronously.
  const settled = () => {
    if (closingOwners.get(owner) === closing) closingOwners.delete(owner);
  };
  // Reuse is legal after actual settlement, never after a caller-only timeout.
  closing.then(settled, settled);
  return closing;
}

function unsupportedCapability(message) {
  return Object.assign(new Error(message), { code: "UNSUPPORTED_BROWSER_CAPABILITY" });
}

async function browserIdentity() {
  const userAgent = typeof navigator === "object" ? String(navigator.userAgent || "") : "";
  let version;
  let versionError;
  try {
    const data = await globalThis.navigator?.userAgentData?.getHighEntropyValues(["fullVersionList"]);
    const brand = data?.fullVersionList?.find(item => item.brand === "Google Chrome")
      || data?.fullVersionList?.find(item => item.brand === "Chromium");
    if (brand && /^\d+\.\d+\.\d+\.\d+$/.test(brand.version)) version = brand.version;
  } catch (error) {
    versionError = String(error?.message || error);
  }
  return {
    kind: "external-browser", resolver: "chrome-extension-native-messaging",
    ...(version ? { browserVersion: version } : {}),
    versionSource: version ? "extension-worker-userAgentData.fullVersionList" : "unavailable",
    ...(versionError ? { versionError } : {}), userAgent,
    extensionVersion: chrome.runtime.getManifest?.().version,
    workerGeneration,
    capabilities: ["dom", "screenshot", "browser-extension", "authenticated-state"],
  };
}

async function handle(message) {
  const method = String(message.method || "");
  const params = message.params || {};
  if (method === "DSH.hello") return { ok: true, group: GROUP_TITLE, protocolVersion: 2, engine: await browserIdentity() };
  const owner = ownerOf(params);
  // Browser.close must never reach the borrowed browser's real CDP command,
  // including when a caller supplies a tab sessionId.
  if (method === "Browser.close") return closeAgentTabs(owner);
  return ownerOperation(owner, method, () => handleOwner(message, method, params, owner));
}

async function handleOwner(message, method, params, owner) {
  if (["Browser.setDownloadBehavior", "Target.createBrowserContext", "Target.disposeBrowserContext"].includes(method)
    || (method === "Target.createTarget" && params.browserContextId !== undefined)) {
    throw unsupportedCapability("The borrowed Chrome extension has no isolated browser context or independent download directory. Use an owned headless browser for these capabilities.");
  }
  if (method === "Browser.getDownloadItems") {
    throw unsupportedCapability("Chrome DownloadItem has no tabId, so this extension cannot prove an owner-scoped download inventory. Downloads still use Chrome normally; no global history is exposed.");
  }
  if (message.sessionId) {
    if (/^(?:Browser|Target)\./.test(method)) {
      throw unsupportedCapability("Browser and target lifecycle commands must use the owner-scoped extension API, not a tab CDP session");
    }
    const tabId = sessions.get(message.sessionId);
    if (tabId == null) throw new Error(`tab session is gone: ${message.sessionId}`);
    await ownedTab(tabId, owner);
    if (ignoreFocusMethod(method)) return {};
    const { dshOwner, ...commandParams } = params;
    return await chrome.debugger.sendCommand({ tabId }, method, commandParams) || {};
  }
  if (ignoreFocusMethod(method)) return {};
  if (method === "Target.setDiscoverTargets") return {};

  if (method === "Target.getTargets") {
    const tabs = await listAgentTabs(owner);
    return {
      targetInfos: tabs.map((tab) => ({
        targetId: sessionIdFor(tab.id),
        type: "page",
        title: tab.title || "",
        url: tab.url || "",
        attached: sessions.has(sessionIdFor(tab.id)),
      })),
    };
  }
  if (method === "Target.createTarget") return createTarget(params.url, owner);
  if (method === "Target.attachToTarget") return attachTab(tabIdFrom(params.targetId), owner);
  if (method === "Target.closeTarget") {
    const tabId = tabIdFrom(params.targetId);
    await ownedTab(tabId, owner);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
    sessions.delete(sessionIdFor(tabId));
    await removeTabs(tabId);
    tabOwners.delete(tabId);
    await saveOwners();
    return { success: true };
  }
  if (method === "Browser.getWindowForTarget") {
    const tab = await ownedTab(tabIdFrom(params.targetId), owner);
    const win = await chrome.windows.get(tab.windowId);
    return {
      windowId: win.id,
      bounds: {
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
        windowState: win.state,
      },
    };
  }
  if (method === "Browser.setWindowBounds") throw unsupportedCapability("Background-tab control does not resize or activate the user's Chrome window");
  throw new Error(`unsupported browser command ${method}`);
}

async function onMessage(message) {
  if (message?.method === "DSH.bridgeConflict") {
    bridgeConflict = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    await chrome.storage.session.set({ "dsh-bridge-conflict": true });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#c92a2a" });
    await chrome.action.setTitle({ title: `DSH Chrome: ${String(message.params?.message || "主机连接冲突").slice(0, 400)}；点击扩展重试` });
    return;
  }
  if (!message || message.id == null) return;
  const pending = pendingMarks.get(message.id);
  if (pending) {
    pendingMarks.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message || "标注保存失败"), { safeToRetry: message.error.code === "MARK_NOT_SAVED" }));
    else if (message.result?.ok === true) pending.resolve(message.result);
    else pending.reject(new Error("DSH Chrome 主机未确认标注保存"));
    return;
  }
  if (!message.method) return;
  try {
    const result = await handle(message);
    post({ id: message.id, result });
  } catch (error) {
    post({ id: message.id, error: { message: error instanceof Error ? error.message : String(error), ...(typeof error?.code === "string" ? { code: error.code } : {}) } });
  }
}

function connect() {
  if (bridgeConflict || port || reconnectTimer) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch {
    scheduleReconnect(5000);
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    for (const pending of pendingMarks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("DSH Chrome 主机断开，未确认标注保存，请先到 DSH 检查"));
    }
    pendingMarks.clear();
    const message = chrome.runtime.lastError?.message || "";
    scheduleReconnect(/not found|forbidden|forbidden/i.test(message) ? 5000 : 1000);
  });
}

function scheduleReconnect(ms) {
  if (bridgeConflict || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, ms);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  const sessionId = sessionIdFor(source.tabId);
  if (!sessions.has(sessionId)) return;
  postEvent({ method, params: params || {}, sessionId });
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  const sessionId = sessionIdFor(source.tabId);
  sessions.delete(sessionId);
  postEvent({ method: "Target.detachedFromTarget", params: { sessionId }, sessionId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, result] of confirmedReviews) if (result.tabId === tabId) confirmedReviews.delete(id);
  const targetId = sessionIdFor(tabId);
  const hadSession = sessions.delete(targetId);
  chrome.storage.session.get(null).then(stored => {
    const keys = Object.keys(stored).filter(key => key.startsWith(REVIEW_PREFIX)
      && stored[key]?.tabId === tabId);
    return keys.length ? chrome.storage.session.remove(keys) : undefined;
  }).catch(error => console.error("DSH review cleanup failed", error));
  loadOwners().then(async () => {
    const hadOwner = tabOwners.delete(tabId);
    if (hadOwner || hadSession) postEvent({ method: "Target.targetDestroyed", params: { targetId } });
    if (hadOwner) await saveOwners();
  }).catch((error) => console.error("DSH tab ownership cleanup failed", error));
});

function flash(text) {
  if (bridgeConflict) return;
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: text === "!" ? "#c92a2a" : "#2f9e44" }).catch(() => {});
  setTimeout(() => {
    if (bridgeConflict) return;
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }, 1600);
}

function postMark(params) {
  if (!port) connect();
  if (!port) throw Object.assign(new Error("DSH Chrome 主机没连上"), { safeToRetry: true });
  const id = `mark:${crypto.randomUUID()}`;
  const message = { id, method: "DSH.mark", params };
  if (JSON.stringify(message).length > 900_000) throw Object.assign(new Error("标注图太大"), { safeToRetry: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMarks.delete(id);
      reject(new Error("DSH Chrome 主机保存确认超时，请先到 DSH 检查"));
    }, 8000);
    pendingMarks.set(id, { resolve, reject, timer });
    try {
      port.postMessage(message);
    } catch (error) {
      pendingMarks.delete(id);
      clearTimeout(timer);
      reject(Object.assign(error, { safeToRetry: true }));
    }
  });
}

async function retryConnection() {
  await conflictReady;
  bridgeConflict = false;
  await chrome.storage.session.remove("dsh-bridge-conflict");
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  chrome.action.setTitle({ title: "选择元素并在扩展侧栏填写要求" }).catch(() => {});
  connect();
}

async function showReviewPanel(tabId, path = "review.html") {
  await chrome.sidePanel.setOptions({ tabId, path, enabled: true });
  try { await chrome.sidePanel.open({ tabId }); } catch { /* already open, or no remaining user gesture */ }
}

chrome.action.onClicked.addListener(async (tab) => {
  await retryConnection();
  if (tab?.id == null || !canPick(tab.url)) {
    flash("!");
    return;
  }
  try {
    await showReviewPanel(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "dsh-pick-start" });
  } catch {
    flash("!");
  }
});

const REVIEW_PREFIX = "dsh-mark-review:";
const reviewing = new Set();
const confirmedReviews = new Map();
const UNCERTAIN_REVIEW = "结果未确认，请先到 DSH 检查；为避免重复，本审核页禁止再次发送。";
const captures = new Set();
const reviewUrl = id => chrome.runtime.getURL(`review.html?id=${id}`);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["dsh-pick-review", "dsh-review-load", "dsh-review-save"].includes(message?.type)) return;
  const operation = message.type === "dsh-pick-review" ? prepareReview(message, sender) : handleReview(message, sender);
  operation.then(result => sendResponse({ ok: true, ...result })).catch(error => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "标注处理失败" });
  });
  return true;
});

async function prepareReview(message, sender) {
  const tab = sender.tab;
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || tab?.id == null || !canPick(message.url)
    || sender.url !== message.url) throw new Error("这个页面不能标注");
  if (captures.has(tab.id)) throw new Error("正在准备标注，请稍后");
  captures.add(tab.id);
  try {
    const items = reviewItems(message.items);
    const viewport = message.viewport;
    if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
      || viewport.width <= 0 || viewport.height <= 0 || viewport.width > 20000 || viewport.height > 20000) throw new Error("页面尺寸无效");
    const current = await chrome.tabs.get(tab.id);
    if (!current.active || current.url !== message.url || current.windowId !== tab.windowId) throw new Error("页面已切换，请回原页面重新选择");
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const after = await chrome.tabs.get(tab.id);
    if (!after.active || after.url !== current.url || after.windowId !== current.windowId) throw new Error("截图时页面已切换，请重试");
    const image = await jpegBoxes(dataUrl, items.map(item => item.box), viewport);
    const id = crypto.randomUUID();
    const key = REVIEW_PREFIX + id;
    // Bind the original http(s) tab. Never open or activate a full-page review tab.
    try {
      await chrome.storage.session.set({ [key]: { tabId: tab.id, expires: Date.now() + 30 * 60_000,
        params: { url: current.url, title: String(message.title || "").slice(0, 200), items, viewport: `${Math.round(viewport.width)}x${Math.round(viewport.height)}`, image } } });
      await showReviewPanel(tab.id, `review.html?id=${id}`);
    } catch (error) {
      await chrome.storage.session.remove(key);
      throw error;
    }
    return {};
  } finally { captures.delete(tab.id); }
}

function reviewItems(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) throw new Error("请选择 1–12 个元素");
  return raw.map(item => {
    const box = item?.box;
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new Error("元素尺寸无效");
    const result = { box: { x: box.x, y: box.y, width: box.width, height: box.height }, styles: {} };
    for (const key of ["tag", "selector", "location", "domPath", "role", "name", "text", "bounds", "html"]) result[key] = String(item[key] || "").slice(0, 800);
    for (const key of ["display", "width", "height", "margin", "padding", "color", "border", "border-radius", "font-family", "font-size", "font-weight", "text-align"]) {
      if (item.styles?.[key]) result.styles[key] = String(item.styles[key]).slice(0, 160);
    }
    // Never copy page-supplied note/intent into the trusted editor.
    return result;
  });
}

async function handleReview(message, sender) {
  if (!/^[a-f0-9-]{36}$/.test(message.id || "") || sender.id !== chrome.runtime.id
    || (sender.frameId != null && sender.frameId !== 0) || sender.url !== reviewUrl(message.id)) throw new Error("要求只能在可信扩展编辑页确认");
  // Side panel pages may omit MessageSender.tab. tabId from the editor is
  // accepted only after the trusted-origin checks above, and must match the bound page tab.
  const key = REVIEW_PREFIX + message.id;
  const record = (await chrome.storage.session.get(key))[key];
  if (!record || record.expires < Date.now()) throw new Error("标注已过期，请重新选择");
  const tabId = sender.tab?.id ?? message.tabId ?? record.tabId;
  if (record.tabId !== tabId) throw new Error("标注已过期，请重新选择");
  if (confirmedReviews.has(message.id)) return confirmedReviews.get(message.id);
  if (record.sent) return { sent: true };
  const current = await chrome.tabs.get(tabId);
  if (current.url !== record.params.url) throw new Error("原页面已切换，请重新选择");
  if (reviewing.has(message.id)) throw new Error("正在保存，请勿重复提交");
  if (record.sending) return { uncertain: true, warning: UNCERTAIN_REVIEW, params: record.params };
  if (message.type === "dsh-review-load") return { params: record.params };
  if (!Array.isArray(message.requests) || message.requests.length !== record.params.items.length) throw new Error("要求数量不匹配");
  const items = record.params.items.map((item, index) => {
    const request = message.requests[index];
    if (typeof request?.note !== "string" || !request.note.trim() || request.note.length > 1000
      || !["change", "ask", "remove"].includes(request.intent)) throw new Error("请为每个元素填写要求（最多 1000 字）");
    return { ...item, note: request.note.trim(), intent: request.intent };
  });
  reviewing.add(message.id);
  try {
    const pending = { ...record, params: { ...record.params, items } };
    // Write-ahead guard: after a crash or missing ACK, never blindly resend.
    await chrome.storage.session.set({ [key]: { ...pending, sending: true } });
    try {
      await postMark(pending.params);
    } catch (error) {
      if (!error.safeToRetry) return { uncertain: true, warning: `${UNCERTAIN_REVIEW} ${error.message}`, params: pending.params };
      try {
        await chrome.storage.session.set({ [key]: pending });
      } catch (storageError) {
        return { uncertain: true, warning: `发送未完成：${error.message}；重试状态未保存：${storageError.message}。${UNCERTAIN_REVIEW}`, params: pending.params };
      }
      throw error;
    }
    const result = { sent: true, tabId: record.tabId };
    confirmedReviews.set(message.id, result);
    try {
      await chrome.storage.session.set({ [key]: { tabId: record.tabId, expires: record.expires, sent: true } });
    } catch (error) {
      result.warning = `主机已保存、审核状态未保存：${error.message}。请到 DSH 检查，不要重新发送。`;
    }
    flash(result.warning ? "!" : "✓");
    return result;
  } finally { reviewing.delete(message.id); }
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onStartup.addListener(retryConnection);
chrome.runtime.onInstalled.addListener(retryConnection);
conflictReady.then(connect).catch(error => console.error("DSH connection state failed", error));

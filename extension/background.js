import { GROUP_TITLE, HOST_NAME, OWNERSHIP_KEY, canPick, groupTitle, ignoreFocusMethod, requireOwner, tabCreateProperties, windowCreateProperties } from "./policy.js";
import { jpegBoxes, jpegCrop } from "./shot.js";

const sessions = new Map();
const tabOwners = new Map();
const pendingMarks = new Map();
let ownersReady = null;
let ownersSaved = Promise.resolve();
let port = null;
let reconnectTimer = null;

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

async function createTarget(url, owner) {
  await loadOwners();
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = wins.find((win) => win.focused) || wins[0];
  let tab;
  if (!focused) {
    const created = await chrome.windows.create(windowCreateProperties(url || "about:blank"));
    tab = created?.tabs?.find((item) => item.id != null);
    if (created?.id == null || tab?.id == null) throw new Error("Chrome has no normal window");
    tab.windowId = created.id;
  } else {
    tab = await chrome.tabs.create(tabCreateProperties(focused.id, url));
    if (tab.id == null) throw new Error("Chrome did not return a tab id");
    tab.windowId ??= focused.id;
  }
  try {
    await groupTab(tab.id, tab.windowId, owner);
    tabOwners.set(tab.id, owner);
    await saveOwners();
  } catch (error) {
    tabOwners.delete(tab.id);
    await chrome.tabs.remove(tab.id);
    throw error;
  }
  return { targetId: sessionIdFor(tab.id) };
}

async function listAgentTabs(owner) {
  await loadOwners();
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id != null && tabOwners.get(tab.id) === owner);
}

async function closeAgentTabs(owner) {
  const tabs = await listAgentTabs(owner);
  const ids = tabs.map((tab) => tab.id).filter((id) => id != null);
  await Promise.all(ids.map(async (tabId) => {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
    sessions.delete(sessionIdFor(tabId));
  }));
  if (ids.length) await chrome.tabs.remove(ids);
  for (const id of ids) tabOwners.delete(id);
  await saveOwners();
  return {};
}

function downloadRow(item) {
  return {
    id: String(item.id),
    url: item.url || "",
    filename: item.filename || "",
    state: item.state || "in_progress",
  };
}

async function agentDownloadItems(owner) {
  const tabs = await listAgentTabs(owner);
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const items = await chrome.downloads.search({ limit: 20, orderBy: ["-startTime"] });
  return items.filter((item) => item.tabId != null && tabIds.has(item.tabId)).map(downloadRow);
}

async function handle(message) {
  const method = String(message.method || "");
  const params = message.params || {};
  if (method === "DSH.hello") return { ok: true, group: GROUP_TITLE, protocolVersion: 2 };
  const owner = ownerOf(params);
  if (message.sessionId) {
    const tabId = sessions.get(message.sessionId);
    if (tabId == null) throw new Error(`tab session is gone: ${message.sessionId}`);
    await ownedTab(tabId, owner);
    if (ignoreFocusMethod(method)) return {};
    const { dshOwner, ...commandParams } = params;
    return await chrome.debugger.sendCommand({ tabId }, method, commandParams) || {};
  }
  if (ignoreFocusMethod(method)) return {};
  if (method === "Target.setDiscoverTargets") return {};
  if (method === "Browser.setDownloadBehavior") return {};
  if (method === "Browser.getDownloadItems") return { items: await agentDownloadItems(owner) };
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
    await chrome.tabs.remove(tabId);
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
  if (method === "Browser.setWindowBounds") return {};
  if (method === "Browser.close") return closeAgentTabs(owner);
  throw new Error(`unsupported browser command ${method}`);
}

async function onMessage(message) {
  if (!message || message.id == null) return;
  const pending = pendingMarks.get(message.id);
  if (pending) {
    pendingMarks.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "标注保存失败"));
    else if (message.result?.ok === true) pending.resolve(message.result);
    else pending.reject(new Error("DSH Chrome 主机未确认标注保存"));
    return;
  }
  if (!message.method) return;
  try {
    const result = await handle(message);
    post({ id: message.id, result });
  } catch (error) {
    post({ id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
  }
}

function connect() {
  if (port || reconnectTimer) return;
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
      pending.reject(new Error("DSH Chrome 主机断开，未确认标注保存，请重试"));
    }
    pendingMarks.clear();
    const message = chrome.runtime.lastError?.message || "";
    scheduleReconnect(/not found|forbidden|forbidden/i.test(message) ? 5000 : 1000);
  });
}

function scheduleReconnect(ms) {
  if (reconnectTimer) return;
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

chrome.downloads.onCreated.addListener((item) => {
  if (item.tabId == null || !sessions.has(sessionIdFor(item.tabId))) return;
  postEvent({ method: "Browser.downloadWillBegin", params: downloadRow(item), sessionId: sessionIdFor(item.tabId) });
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.filename && !delta.state) return;
  chrome.downloads.search({ id: delta.id }).then((items) => {
    const item = items[0];
    if (!item || item.tabId == null || !sessions.has(sessionIdFor(item.tabId))) return;
    postEvent({ method: "Browser.downloadProgress", params: downloadRow(item), sessionId: sessionIdFor(item.tabId) });
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const targetId = sessionIdFor(tabId);
  const hadSession = sessions.delete(targetId);
  loadOwners().then(async () => {
    const hadOwner = tabOwners.delete(tabId);
    if (hadOwner || hadSession) postEvent({ method: "Target.targetDestroyed", params: { targetId } });
    if (hadOwner) await saveOwners();
  }).catch((error) => console.error("DSH tab ownership cleanup failed", error));
});

function flash(text) {
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: text === "!" ? "#c92a2a" : "#2f9e44" }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "" }).catch(() => {});
  }, 1600);
}

function postMark(params) {
  if (!port) connect();
  if (!port) throw new Error("DSH Chrome 主机没连上");
  const id = `mark:${crypto.randomUUID()}`;
  const message = { id, method: "DSH.mark", params };
  if (JSON.stringify(message).length > 900_000) throw new Error("标注图太大");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingMarks.delete(id);
      reject(new Error("DSH Chrome 主机保存确认超时，请重试"));
    }, 8000);
    pendingMarks.set(id, { resolve, reject, timer });
    try {
      port.postMessage(message);
    } catch (error) {
      pendingMarks.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id == null || !canPick(tab.url)) {
    flash("!");
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["picker.js"] });
    await chrome.tabs.sendMessage(tab.id, { type: "dsh-pick-start" });
  } catch {
    flash("!");
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== "dsh-pick") return;
  port.onMessage.addListener((message) => {
    const tab = port.sender && port.sender.tab;
    if (!message || tab?.id == null || tab.windowId == null || !canPick(message.url)) {
      port.postMessage({ ok: false, error: "这个页面不能标注" });
      return;
    }
    captureAndSend(tab, message)
      .then(() => {
        flash("✓");
        port.postMessage({ ok: true });
      })
      .catch((error) => {
        flash("!");
        port.postMessage({ ok: false, error: error instanceof Error ? error.message : "没送出" });
      });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "dsh-pick") return;
  const tab = sender.tab;
  if (tab?.id == null || tab.windowId == null || !canPick(message.url)) {
    sendResponse({ ok: false, error: "这个页面不能标注" });
    return;
  }
  captureAndSend(tab, message)
    .then(() => {
      flash("✓");
      sendResponse({ ok: true });
    })
    .catch((error) => {
      flash("!");
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "没送出" });
    });
  return true;
});

async function captureAndSend(tab, message) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const items = Array.isArray(message.items) ? message.items.filter((item) => item && item.box) : [];
  const image = items.length
    ? await jpegBoxes(dataUrl, items.map((item) => item.box), message.viewport)
    : await jpegCrop(dataUrl, message.box, message.viewport);
  const first = items[0] || {};
  await postMark({
    url: message.url,
    title: message.title,
    selector: message.selector || first.selector,
    role: message.role || first.role,
    name: message.name || first.name,
    text: message.text || first.text,
    items,
    viewport: message.viewport
      ? `${Math.round(Number(message.viewport.width) || 0)}x${Math.round(Number(message.viewport.height) || 0)}`
      : "",
    image,
  });
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

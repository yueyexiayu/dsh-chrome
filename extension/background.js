import { GROUP_TITLE, HOST_NAME, groupTitle, ignoreFocusMethod, tabCreateProperties, windowCreateProperties } from "./policy.js";

const sessions = new Map();
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
  const owner = params && params.dshOwner;
  return typeof owner === "string" && owner.trim() ? owner.trim() : "default";
}

async function groupTab(tabId, windowId, owner) {
  const title = groupTitle(owner);
  const existing = await chrome.tabGroups.query({ title, windowId });
  if (existing[0]) {
    await chrome.tabs.group({ groupId: existing[0].id, tabIds: tabId });
    return existing[0].id;
  }
  const groupId = await chrome.tabs.group({
    tabIds: tabId,
    createProperties: { windowId },
  });
  await chrome.tabGroups.update(groupId, { title, color: "blue", collapsed: true });
  return groupId;
}

async function attachTab(tabId) {
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
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const focused = wins.find((win) => win.focused) || wins[0];
  if (!focused) {
    const created = await chrome.windows.create(windowCreateProperties(url || "about:blank"));
    const tab = created?.tabs?.find((item) => item.id != null);
    if (created?.id == null || tab?.id == null) throw new Error("Chrome has no normal window");
    await groupTab(tab.id, created.id, owner);
    return { targetId: sessionIdFor(tab.id) };
  }
  const tab = await chrome.tabs.create(tabCreateProperties(focused.id, url));
  if (tab.id == null) throw new Error("Chrome did not return a tab id");
  await groupTab(tab.id, tab.windowId ?? focused.id, owner);
  return { targetId: sessionIdFor(tab.id) };
}

async function listAgentTabs(owner) {
  const groups = await chrome.tabGroups.query({ title: groupTitle(owner) });
  const groupIds = new Set(groups.map((group) => group.id));
  if (groupIds.size === 0) return [];
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id != null && groupIds.has(tab.groupId));
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
  const owner = ownerOf(params);
  if (method === "DSH.hello") return { ok: true, group: GROUP_TITLE };
  if (ignoreFocusMethod(method)) return {};
  if (message.sessionId) {
    const tabId = sessions.get(message.sessionId);
    if (tabId == null) throw new Error(`tab session is gone: ${message.sessionId}`);
    return await chrome.debugger.sendCommand({ tabId }, method, params) || {};
  }
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
  if (method === "Target.attachToTarget") return attachTab(tabIdFrom(params.targetId));
  if (method === "Target.closeTarget") {
    const tabId = tabIdFrom(params.targetId);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // already detached
    }
    sessions.delete(sessionIdFor(tabId));
    await chrome.tabs.remove(tabId);
    return { success: true };
  }
  if (method === "Browser.getWindowForTarget") {
    const tab = await chrome.tabs.get(tabIdFrom(params.targetId));
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
  sessions.delete(sessionIdFor(tabId));
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

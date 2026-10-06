import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import * as policy from "../extension/policy.js";

// Execute the actual service worker with isolated Chrome APIs, without a browser.
function worker(shared = { tabs: new Map(), stored: {}, next: 1, group: 1 }) {
  const events = {};
  const sent = [];
  const commands = [];
  const timers = new Map();
  const event = (name) => ({ addListener(fn) { events[name] = fn; } });
  const native = {
    onMessage: event("nativeMessage"), onDisconnect: event("nativeDisconnect"),
    postMessage(message) { sent.push(message); },
  };
  const chrome = {
    storage: { session: {
      async get() { return structuredClone(shared.stored); },
      async set(value) { Object.assign(shared.stored, structuredClone(value)); },
    } },
    windows: { async getAll() { return [{ id: 1, focused: true }]; }, async get(id) { return { id }; } },
    tabs: {
      async create(props) { const tab = { ...props, id: shared.next++, groupId: -1 }; shared.tabs.set(tab.id, tab); return { ...tab }; },
      async get(id) { if (!shared.tabs.has(id)) throw new Error("No tab with id"); return { ...shared.tabs.get(id) }; },
      async query(query) { return [...shared.tabs.values()].filter((tab) => query.windowId == null || tab.windowId === query.windowId).map((tab) => ({ ...tab })); },
      async group(props) { const id = props.groupId ?? shared.group++; shared.tabs.get(props.tabIds).groupId = id; return id; },
      async remove(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) shared.tabs.delete(id); },
      async captureVisibleTab() { return "data:image/png;base64,aA=="; },
      onRemoved: event("removed"),
    },
    tabGroups: { async update() {} },
    debugger: {
      async attach() {}, async detach() {},
      async sendCommand(source, method, params) { commands.push({ source, method, params }); return {}; },
      onEvent: event("debuggerEvent"), onDetach: event("detach"),
    },
    downloads: { onCreated: event("downloadCreated"), onChanged: event("downloadChanged") },
    action: { onClicked: event("click"), async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    runtime: {
      connectNative() { return native; }, onConnect: event("pickerConnect"), onMessage: event("pickerMessage"),
      onStartup: event("startup"), onInstalled: event("installed"),
    },
  };
  let timerId = 0;
  const context = vm.createContext({
    ...policy, chrome, console, crypto: { randomUUID },
    async jpegBoxes() { return "aA=="; }, async jpegCrop() { return "aA=="; },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(`${source}\nglobalThis.api = { handle, postMark, captureAndSend };`, context);
  return { shared, events, sent, commands, timers, native, ...context.api };
}

const command = (method, dshOwner, params = {}, sessionId) => ({ method, params: { ...params, dshOwner }, sessionId });

test("full owners with colliding display suffix stay isolated, including browser close", async () => {
  const w = worker();
  const first = await w.handle(command("Target.createTarget", "alpha-123456"));
  const second = await w.handle(command("Target.createTarget", "beta-123456"));
  const ids = [...w.shared.tabs.keys()];
  assert.notEqual(w.shared.tabs.get(ids[0]).groupId, w.shared.tabs.get(ids[1]).groupId);
  const list = await w.handle(command("Target.getTargets", "alpha-123456"));
  assert.deepEqual(Array.from(list.targetInfos, (tab) => tab.targetId), [first.targetId]);
  await w.handle(command("Browser.close", "alpha-123456"));
  assert.equal(w.shared.tabs.size, 1);
  assert.equal(`tab-${[...w.shared.tabs.keys()][0]}`, second.targetId);
});

test("foreign, manually grouped, and ownerless targets cannot be attached or closed", async () => {
  const w = worker();
  const target = await w.handle(command("Target.createTarget", "alpha"));
  const owned = [...w.shared.tabs.values()][0];
  w.shared.tabs.set(99, { id: 99, windowId: 1, groupId: owned.groupId });
  for (const method of ["Target.attachToTarget", "Target.closeTarget", "Browser.getWindowForTarget"]) {
    await assert.rejects(w.handle(command(method, "beta", target)), /does not belong/);
    await assert.rejects(w.handle(command(method, "alpha", { targetId: "tab-99" })), /does not belong/);
    await assert.rejects(w.handle({ method, params: target }), /owner is required/);
  }
  assert.equal(w.shared.tabs.size, 2);
});

test("session commands verify full owner and remove internal owner from CDP params", async () => {
  const w = worker();
  const target = await w.handle(command("Target.createTarget", "alpha"));
  const attached = await w.handle(command("Target.attachToTarget", "alpha", target));
  await assert.rejects(w.handle(command("Runtime.evaluate", "beta", { expression: "1" }, attached.sessionId)), /does not belong/);
  await assert.rejects(w.handle(command("Page.bringToFront", "beta", {}, attached.sessionId)), /does not belong/);
  await w.handle(command("Runtime.evaluate", "alpha", { expression: "1" }, attached.sessionId));
  assert.equal(w.commands.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(w.commands[0].params)), { expression: "1" });
});

test("service worker restart restores exact owners independently of user grouping", async () => {
  const w = worker();
  const target = await w.handle(command("Target.createTarget", "alpha-123456"));
  [...w.shared.tabs.values()][0].groupId = -1;
  const restarted = worker(w.shared);
  const list = await restarted.handle(command("Target.getTargets", "alpha-123456"));
  assert.equal(list.targetInfos[0].targetId, target.targetId);
  await assert.rejects(restarted.handle(command("Target.closeTarget", "beta-123456", target)), /does not belong/);
  await restarted.handle(command("Target.closeTarget", "alpha-123456", target));
  assert.equal(w.shared.tabs.size, 0);
});

test("new owned tabs do not join a group that now includes a user tab", async () => {
  const w = worker();
  await w.handle(command("Target.createTarget", "alpha"));
  const first = [...w.shared.tabs.values()][0];
  w.shared.tabs.set(99, { id: 99, windowId: 1, groupId: first.groupId });
  const second = await w.handle(command("Target.createTarget", "alpha"));
  assert.notEqual(w.shared.tabs.get(Number(second.targetId.slice(4))).groupId, first.groupId);
  await w.handle(command("Browser.close", "alpha"));
  assert.deepEqual([...w.shared.tabs.keys()], [99]);
});

test("hello declares the protocol with strict ownership and acknowledged marks", async () => {
  const w = worker();
  assert.equal((await w.handle({ method: "DSH.hello" })).protocolVersion, 2);
});

test("owned tab removal destroys its target before or after debugger detach, while user tabs stay silent", async () => {
  for (const detachFirst of [true, false]) {
    const w = worker();
    const target = await w.handle(command("Target.createTarget", "alpha"));
    await w.handle(command("Target.attachToTarget", "alpha", target));
    const tabId = Number(target.targetId.slice(4));
    if (detachFirst) w.events.detach({ tabId });
    w.events.removed(tabId);
    if (!detachFirst) w.events.detach({ tabId });
    await new Promise((resolve) => setImmediate(resolve));
    const destroyed = w.sent.filter((message) => message.method === "Target.targetDestroyed");
    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].params.targetId, target.targetId);
    w.events.removed(99);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(w.sent.filter((message) => message.method === "Target.targetDestroyed").length, 1);
  }
});

test("mark capture reports success only after the corresponding host save acknowledgement", async () => {
  const w = worker();
  let settled = false;
  const sending = w.captureAndSend({ windowId: 1 }, { url: "https://example.com" }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  const request = w.sent.at(-1);
  assert.equal(request.method, "DSH.mark");
  assert.match(request.id, /^mark:/);
  await w.events.nativeMessage({ id: "wrong-id", result: { ok: true } });
  assert.equal(settled, false);
  await w.events.nativeMessage({ id: request.id, result: { ok: true, markId: "saved" } });
  await sending;
  assert.equal(settled, true);
});

test("mark save failure, malformed ack, timeout and disconnect are explicit failures", async () => {
  for (const scenario of ["save-error", "malformed", "timeout", "disconnect", "send-error"]) {
    const w = worker();
    if (scenario === "send-error") w.native.postMessage = () => { throw new Error("write failed"); };
    const pending = w.postMark({ image: "aA==" });
    const rejected = assert.rejects(pending, /disk full|未确认|超时|断开|write failed/);
    const id = w.sent.at(-1)?.id;
    if (scenario === "save-error") await w.events.nativeMessage({ id, error: { message: "disk full" } });
    if (scenario === "malformed") await w.events.nativeMessage({ id, result: {} });
    if (scenario === "timeout") [...w.timers.values()].find((timer) => timer.ms === 8000).fn();
    if (scenario === "disconnect") w.events.nativeDisconnect();
    await rejected;
  }
});

test("the picker callback receives a visible failure when host persistence fails", async () => {
  const w = worker();
  const replies = [];
  const message = { type: "dsh-pick", url: "https://example.com", text: "keep my note" };
  assert.equal(w.events.pickerMessage(message, { tab: { id: 99, windowId: 1 } }, (reply) => replies.push(reply)), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.length, 0);
  await w.events.nativeMessage({ id: w.sent.at(-1).id, error: { message: "disk full" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error, "disk full");
  assert.equal(message.text, "keep my note");
});

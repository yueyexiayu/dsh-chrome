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
      async set(value) { if (shared.beforeSet) await shared.beforeSet(value); Object.assign(shared.stored, structuredClone(value)); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete shared.stored[key]; },
    } },
    windows: { async getAll() { return [{ id: 1, focused: true }]; }, async get(id) { return { id }; } },
    tabs: {
      async create(props) { const tab = { ...props, id: shared.next++, groupId: -1 }; shared.tabs.set(tab.id, tab); return { ...tab }; },
      async get(id) { if (!shared.tabs.has(id)) throw new Error("No tab with id"); return { ...shared.tabs.get(id) }; },
      async query(query) { return [...shared.tabs.values()].filter((tab) => query.windowId == null || tab.windowId === query.windowId).map((tab) => ({ ...tab })); },
      async group(props) { const id = props.groupId ?? shared.group++; shared.tabs.get(props.tabIds).groupId = id; return id; },
      async remove(ids) { for (const id of Array.isArray(ids) ? ids : [ids]) shared.tabs.delete(id); },
      async update(id, props) { Object.assign(shared.tabs.get(id), props); },
      async captureVisibleTab() { if (shared.capture) await shared.capture(); return "data:image/png;base64,aA=="; },
      onRemoved: event("removed"),
    },
    tabGroups: { async update() {} },
    debugger: {
      async attach() {}, async detach() {},
      async sendCommand(source, method, params) { commands.push({ source, method, params }); return {}; },
      onEvent: event("debuggerEvent"), onDetach: event("detach"),
    },
    downloads: { onCreated: event("downloadCreated"), onChanged: event("downloadChanged") },
    action: { onClicked: event("click"), async setBadgeText({ text }) { shared.badge = text; }, async setBadgeBackgroundColor() {}, async setTitle({ title }) { shared.title = title; } },
    runtime: {
      id: "fixture-extension", getURL(file) { return `chrome-extension://fixture-extension/${file}`; },
      connectNative() { return native; }, onConnect: event("pickerConnect"), onMessage: event("pickerMessage"),
      onStartup: event("startup"), onInstalled: event("installed"),
    },
  };
  let timerId = 0;
  const context = vm.createContext({
    ...policy, chrome, console, crypto: { randomUUID },
    async jpegBoxes() { return "aA=="; },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(`${source}\nglobalThis.api = { handle, postMark, prepareReview, handleReview, retryConnection };`, context);
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

async function reviewFixture(w = worker()) {
  const tab = { id: 99, windowId: 1, active: true, url: "https://example.com/" };
  w.shared.tabs.set(tab.id, tab);
  const pageSender = { id: "fixture-extension", frameId: 0, url: tab.url, tab };
  const message = { type: "dsh-pick-review", url: tab.url, title: "<script>evil</script>",
    viewport: { width: 800, height: 600 }, items: [{ selector: "#x", text: "untrusted", note: "FORGED_REQUEST", intent: "remove", box: { x: 1, y: 1, width: 20, height: 20 } }] };
  await w.prepareReview(message, pageSender);
  const key = Object.keys(w.shared.stored).find(key => key.startsWith("dsh-mark-review:"));
  const id = key.slice("dsh-mark-review:".length);
  const record = w.shared.stored[key];
  const sender = { id: "fixture-extension", frameId: 0, url: `chrome-extension://fixture-extension/review.html?id=${id}`, tab: { id: record.tabId } };
  return { w, id, key, sender, pageSender, message, save: { type: "dsh-review-save", id, requests: [{ note: "Real user request", intent: "change" }] } };
}

test("trusted review reports success only after the corresponding host save acknowledgement", async () => {
  const { w, save, sender } = await reviewFixture();
  assert.equal(w.sent.length, 0, "page data alone must never post a mark");
  let settled = false;
  const sending = w.handleReview(save, sender).then(() => { settled = true; });
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
    if (scenario === "save-error") await w.events.nativeMessage({ id, error: { code: "MARK_NOT_SAVED", message: "disk full" } });
    if (scenario === "malformed") await w.events.nativeMessage({ id, result: {} });
    if (scenario === "timeout") [...w.timers.values()].find((timer) => timer.ms === 8000).fn();
    if (scenario === "disconnect") w.events.nativeDisconnect();
    await rejected;
  }
});

test("review callback exposes host failure and retains pending data for retry", async () => {
  const { w, save, sender, key } = await reviewFixture();
  const replies = [];
  assert.equal(w.events.pickerMessage(save, sender, reply => replies.push(reply)), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.length, 0);
  await w.events.nativeMessage({ id: w.sent.at(-1).id, error: { code: "MARK_NOT_SAVED", message: "disk full" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies[0].ok, false);
  assert.equal(replies[0].error, "disk full");
  assert.ok(w.shared.stored[key].params);
  const retry = w.handleReview(save, sender);
  await new Promise(resolve => setImmediate(resolve));
  await w.events.nativeMessage({ id: w.sent.at(-1).id, result: { ok: true } });
  await retry;
  assert.equal(w.shared.stored[key].sent, true);
});

test("page-supplied Request and intent are stripped and old direct-send path is absent", async () => {
  const { w, id, sender } = await reviewFixture();
  const loaded = await w.handleReview({ type: "dsh-review-load", id }, sender);
  assert.equal(loaded.params.items[0].note, undefined);
  assert.equal(loaded.params.items[0].intent, undefined);
  assert.equal(loaded.params.items[0].text, "untrusted");
  assert.equal(w.events.pickerMessage({ type: "dsh-pick" }, sender, () => assert.fail()), undefined);
  assert.equal(w.sent.length, 0);
});

test("review rejects forged sender, foreign tab, subframe, expired record and empty request", async () => {
  const { w, save, sender, pageSender, key } = await reviewFixture();
  for (const forged of [pageSender, { ...sender, id: "other-extension" }, { ...sender, frameId: 1 },
    { ...sender, tab: { id: 77 } }, { ...sender, url: sender.url + "#forged" }]) {
    await assert.rejects(w.handleReview(save, forged), /可信|过期/);
  }
  await assert.rejects(w.handleReview({ ...save, requests: [{ note: "", intent: "change" }] }, sender), /填写/);
  w.shared.stored[key].expires = Date.now() - 1;
  await assert.rejects(w.handleReview(save, sender), /过期/);
  assert.equal(w.sent.length, 0);
});

test("extension-page messages without sender.tab still require bound tab and exact current URL", async () => {
  const { w, id, sender } = await reviewFixture();
  const withoutTab = { id: sender.id, url: sender.url };
  const message = { type: "dsh-review-load", id, tabId: sender.tab.id };
  assert.ok((await w.handleReview(message, withoutTab)).params);
  await assert.rejects(w.handleReview({ ...message, tabId: 99 }, withoutTab), /过期/);
  w.shared.tabs.get(sender.tab.id).url = "https://changed.invalid/";
  await assert.rejects(w.handleReview(message, withoutTab), /切换/);
});

test("capture rejects changed URL or background tab, including navigation during capture", async () => {
  for (const mode of ["url", "inactive", "during"]) {
    const { w, message, pageSender } = await reviewFixture();
    const tab = w.shared.tabs.get(99);
    if (mode === "url") tab.url = "https://changed.invalid/";
    if (mode === "inactive") tab.active = false;
    if (mode === "during") w.shared.capture = () => { tab.url = "https://changed.invalid/"; };
    await assert.rejects(w.prepareReview(message, pageSender), /切换/);
    assert.equal(w.sent.length, 0);
  }
});

test("review survives service worker restart and suppresses concurrent or repeated submission", async () => {
  const { w, save, sender } = await reviewFixture();
  const fresh = worker(w.shared);
  const first = fresh.handleReview(save, sender);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(fresh.handleReview(save, sender), /正在保存/);
  await fresh.events.nativeMessage({ id: fresh.sent.at(-1).id, result: { ok: true } });
  await first;
  assert.equal((await fresh.handleReview(save, sender)).sent, true);
  assert.equal(fresh.sent.length, 1);
});

test("sent-state storage failure reports host success and blocks retry in this worker and after restart", async () => {
  const { w, save, sender, key } = await reviewFixture();
  w.shared.beforeSet = value => { if (value[key]?.sent) throw new Error("storage unavailable"); };
  const pending = w.handleReview(save, sender);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.shared.stored[key].sending, true);
  assert.equal(w.shared.stored[key].params.items[0].note, "Real user request");
  await w.events.nativeMessage({ id: w.sent.at(-1).id, result: { ok: true } });
  const result = await pending;
  assert.equal(result.sent, true);
  assert.match(result.warning, /主机已保存、审核状态未保存.*storage unavailable/);
  assert.equal((await w.handleReview(save, sender)).sent, true);
  assert.equal(w.sent.length, 1);
  const fresh = worker(w.shared);
  const restored = await fresh.handleReview(save, sender);
  assert.equal(restored.uncertain, true);
  assert.match(restored.warning, /结果未确认.*先到 DSH 检查/);
  assert.equal(restored.params.items[0].note, "Real user request");
  assert.equal(fresh.sent.length, 0);
});

test("missing or malformed ACK blocks same-review retries and persists the user's request", async () => {
  for (const mode of ["timeout", "disconnect", "malformed", "host-unknown"]) {
    const { w, save, sender, key } = await reviewFixture();
    const pending = w.handleReview(save, sender);
    await new Promise(resolve => setImmediate(resolve));
    if (mode === "timeout") [...w.timers.values()].find(timer => timer.ms === 8000).fn();
    if (mode === "disconnect") w.events.nativeDisconnect();
    if (mode === "malformed") await w.events.nativeMessage({ id: w.sent.at(-1).id, result: {} });
    if (mode === "host-unknown") await w.events.nativeMessage({ id: w.sent.at(-1).id, error: { message: "directory fsync failed after rename" } });
    const result = await pending;
    assert.equal(result.uncertain, true);
    assert.equal(w.shared.stored[key].sending, true);
    assert.equal((await w.handleReview(save, sender)).uncertain, true);
    assert.equal(w.sent.length, 1);
    const fresh = worker(w.shared);
    const loaded = await fresh.handleReview({ ...save, type: "dsh-review-load" }, sender);
    assert.equal(loaded.uncertain, true);
    assert.equal(loaded.params.items[0].note, "Real user request");
    assert.equal((await fresh.handleReview(save, sender)).uncertain, true);
    assert.equal(fresh.sent.length, 0);
  }
});

test("write-ahead storage failure sends nothing and permits a safe retry", async () => {
  const { w, save, sender, key } = await reviewFixture();
  w.shared.beforeSet = value => { if (value[key]?.sending) throw new Error("cannot persist sending"); };
  await assert.rejects(w.handleReview(save, sender), /cannot persist sending/);
  assert.equal(w.sent.length, 0);
  assert.equal(w.shared.stored[key].sending, undefined);
  delete w.shared.beforeSet;
  const retry = w.handleReview(save, sender);
  await new Promise(resolve => setImmediate(resolve));
  await w.events.nativeMessage({ id: w.sent.at(-1).id, result: { ok: true } });
  assert.equal((await retry).sent, true);
});

test("definite post failure restores pending state, while failed restoration remains blocked", async () => {
  for (const failRestore of [false, true]) {
    const { w, save, sender, key } = await reviewFixture();
    w.native.postMessage = () => { throw new Error("not posted"); };
    if (failRestore) w.shared.beforeSet = value => {
      if (value[key] && !value[key].sending) throw new Error("cannot restore pending");
    };
    if (!failRestore) {
      await assert.rejects(w.handleReview(save, sender), /not posted/);
      assert.equal(w.shared.stored[key].sending, undefined);
      assert.equal(w.shared.stored[key].params.items[0].note, "Real user request");
      w.native.postMessage = message => w.sent.push(message);
      const retry = w.handleReview(save, sender);
      await new Promise(resolve => setImmediate(resolve));
      await w.events.nativeMessage({ id: w.sent.at(-1).id, result: { ok: true } });
      assert.equal((await retry).sent, true);
    } else {
      const result = await w.handleReview(save, sender);
      assert.equal(result.uncertain, true);
      assert.match(result.warning, /not posted.*cannot restore pending/);
      assert.equal((await w.handleReview(save, sender)).uncertain, true);
      assert.equal(w.shared.stored[key].sending, true);
    }
  }
});

test("review UI distinguishes confirmed rejection from uncertain or partially recorded success", async () => {
  const source = readFileSync(new URL("../extension/review.js", import.meta.url), "utf8");
  for (const mode of ["uncertain", "sent-warning", "undefined", "malformed", "transport-error", "definite-rejection"]) {
    class Element {
      constructor() { this.children = []; this.disabled = true; this.value = ""; this.listeners = {}; }
      append(...children) { this.children.push(...children); }
      addEventListener(type, handler) { this.listeners[type] = handler; }
      async decode() {}
    }
    const nodes = Object.fromEntries(["status", "save", "source", "preview", "items", "review"].map(id => [id, new Element()]));
    const created = [];
    const context = vm.createContext({ URL, location: { href: "https://fixture.invalid/review.html?id=test" },
      document: { getElementById: id => nodes[id], createElement: tag => { const element = new Element(); element.tag = tag; created.push(element); return element; } },
      chrome: { tabs: { async getCurrent() { return { id: 1 }; } }, runtime: { async sendMessage(message) {
        if (message.type === "dsh-review-load") return { ok: true, params: { title: "Fixture", url: "https://fixture.invalid/", image: "fixture", items: [{}] } };
        if (mode === "transport-error") throw new Error("channel closed");
        if (mode === "undefined") return undefined;
        if (mode === "malformed") return {};
        if (mode === "definite-rejection") return { ok: false, error: "not saved" };
        if (mode === "sent-warning") return { ok: true, sent: true, warning: "主机已保存、审核状态未保存" };
        return { ok: true, uncertain: true, warning: "结果未确认，请先到 DSH 检查" };
      } } } });
    await vm.runInContext(`(async () => { ${source}\n })()`, context);
    const note = created.find(element => element.tag === "textarea");
    assert.equal(note.value, "");
    note.value = "Keep my user request";
    await nodes.review.listeners.submit({ isTrusted: true, preventDefault() {} });
    assert.equal(note.value, "Keep my user request");
    assert.equal(nodes.save.disabled, mode !== "definite-rejection");
    assert.match(nodes.status.textContent, mode === "sent-warning" ? /主机已保存、审核状态未保存/
      : mode === "definite-rejection" ? /保存失败.*not saved/ : /结果未确认.*先到 DSH 检查/);
  }
});

test("picker HTML removes password values from self and descendants without changing the live page", () => {
  class Node {
    constructor(tag, attrs = {}, children = [], text = "") {
      this.tagName = tag.toUpperCase(); this.attrs = { ...attrs }; this.children = children; this.innerText = text;
      this.value = attrs.value || ""; this.id = "selected";
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    cloneNode() { return new Node(this.tagName, this.attrs, this.children.map(child => child.cloneNode()), this.innerText); }
    querySelectorAll(selector) {
      assert.equal(selector, "input");
      return this.children.flatMap(child => [...(child.tagName === "INPUT" ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 30 }; }
    get outerHTML() {
      const attrs = Object.entries(this.attrs).map(([key, value]) => ` ${key}="${value}"`).join("");
      return `<${this.tagName.toLowerCase()}${attrs}>${this.innerText}${this.children.map(child => child.outerHTML).join("")}</${this.tagName.toLowerCase()}>`;
    }
  }
  const source = readFileSync(new URL("../extension/picker.js", import.meta.url), "utf8");
  const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener() {} } } },
    CSS: { escape: value => value }, document: { querySelectorAll: () => [{}] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }) });
  vm.runInContext(source.replace("  chrome.runtime.onMessage.addListener", "  globalThis.describeForTest = describe;\n  chrome.runtime.onMessage.addListener"), context);
  const password = new Node("input", { type: "PASSWORD", value: "fixture-password-secret", placeholder: "Keep placeholder", "aria-label": "Password" });
  const ordinary = new Node("input", { type: "text", value: "ordinary value" });
  const parent = new Node("div", { class: "keep-class" }, [password, ordinary], "Keep surrounding text");
  for (const selected of [password, parent]) {
    const before = selected.outerHTML;
    const described = context.describeForTest(selected);
    assert.doesNotMatch(described.html, /fixture-password-secret/);
    assert.match(described.html, /placeholder="Keep placeholder"/);
    assert.match(described.html, /aria-label="Password"/);
    assert.equal(selected.outerHTML, before);
    assert.equal(password.value, "fixture-password-secret");
  }
  const html = context.describeForTest(parent).html;
  assert.match(html, /Keep surrounding text/);
  assert.match(html, /class="keep-class"/);
  assert.match(html, /value="ordinary value"/);
});

test("bridge conflict is visible and prevents automatic retries across worker restarts", async () => {
  const w = worker();
  await new Promise(resolve => setImmediate(resolve));
  await w.events.nativeMessage({ method: "DSH.bridgeConflict", params: { message: "socket belongs to another host" } });
  w.events.nativeDisconnect();
  assert.equal(w.shared.badge, "!");
  assert.match(w.shared.title, /another host/);
  assert.equal(w.timers.size, 0);
  const fresh = worker(w.shared);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fresh.events.nativeMessage, undefined);
  await fresh.retryConnection();
  assert.equal(typeof fresh.events.nativeMessage, "function");
});

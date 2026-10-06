import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

function browser() {
  const source = readFileSync(new URL("../lib/browser.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "")
    + '\nglobalThis.audit={pages,onBrowserEvent,ensure,ensurePage,adoptPage,shutdown,Cdp,setBridge(value){bridge=value;}};';
  const context = { currentOwner: () => "owner-a", setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  return context.audit;
}

test("detach and destroy invalidate only the matching conversation cache", () => {
  for (const method of ["Target.detachedFromTarget", "Target.targetDestroyed"]) {
    const api = browser();
    api.pages.set("owner-a", { sessionId: "tab-1", targetId: "tab-1" });
    api.pages.set("owner-b", { sessionId: "tab-2", targetId: "tab-2" });
    api.onBrowserEvent({ method, params: method.endsWith("targetDestroyed") ? { targetId: "tab-1" } : { sessionId: "tab-1" } });
    assert.equal(api.pages.has("owner-a"), false);
    assert.equal(api.pages.has("owner-b"), true);
  }
});

test("unknown requested target fails rather than silently creating a different tab", async () => {
  const api = browser();
  const calls = [];
  await assert.rejects(api.ensurePage({ send: async (method) => { calls.push(method); return { targetInfos: [] }; } }, undefined, "tab-foreign"), /does not belong/);
  assert.deepEqual(calls, ["Target.getTargets"]);
});

test("failed close remains a visible failure and keeps retryable state", async () => {
  const api = browser();
  api.pages.set("owner-a", { cdp: { closed: false, send: async () => { throw new Error("bridge offline"); } } });
  await assert.rejects(api.shutdown(), /bridge offline/);
  assert.equal(api.pages.has("owner-a"), true);
});

test("every CDP command carries the owner without mutating caller parameters", async () => {
  const api = browser();
  let payload;
  const handlers = {};
  const cdp = new api.Cdp({ addEventListener: (name, fn) => { handlers[name] = fn; }, send: (raw) => { payload = JSON.parse(raw); } });
  const params = { expression: "1" };
  const pending = cdp.send("Runtime.evaluate", params, "tab-1");
  assert.equal(payload.params.dshOwner, "owner-a");
  assert.equal(params.dshOwner, undefined);
  handlers.message({ data: JSON.stringify({ id: payload.id, result: { value: 1 } }) });
  assert.equal((await pending).value, 1);
});

test("detach promptly fails in-flight commands and event waits for that tab", async () => {
  const api = browser();
  const handlers = {};
  const payloads = [];
  const cdp = new api.Cdp({ addEventListener: (name, fn) => { handlers[name] = fn; }, send: (raw) => payloads.push(JSON.parse(raw)) });
  const first = assert.rejects(cdp.send("Runtime.evaluate", {}, "tab-1"), /disconnected/);
  const second = cdp.send("Runtime.evaluate", {}, "tab-2");
  const wait = assert.rejects(cdp.waitFor("Page.loadEventFired", "tab-1", null, 1000), /disconnected/);
  handlers.message({ data: JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "tab-1" } }) });
  handlers.message({ data: JSON.stringify({ id: payloads[1].id, result: { otherTab: true } }) });
  await Promise.all([first, wait]);
  assert.equal((await second).otherTab, true);
  assert.equal(cdp.pending.size, 0);
});

test("group close still works after the cached tab was detached", async () => {
  const api = browser();
  const calls = [];
  api.setBridge({ closed: false, send: async (method, params) => { calls.push({ method, owner: params.dshOwner }); }, close() {} });
  await api.shutdown();
  assert.equal(calls[0].method, "Browser.close");
  assert.equal(calls[0].owner, "owner-a");
});

test("adopting a replacement tab restores the cache invalidated by close", () => {
  const api = browser();
  const state = { owner: "owner-a", sessionId: "tab-1", targetId: "tab-1" };
  api.pages.set("owner-a", state);
  api.onBrowserEvent({ method: "Target.detachedFromTarget", params: { sessionId: "tab-1" } });
  api.adoptPage(state, { sessionId: "tab-2", targetId: "tab-2" });
  assert.equal(api.pages.get("owner-a"), state);
  assert.equal(state.sessionId, "tab-2");
});

test("attached background pages enable virtual focus before input without activating Chrome", async () => {
  const api = browser();
  const calls = [];
  await api.ensurePage({ send: async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: [{ targetId: "tab-1", type: "page", url: "https://example.test" }] };
    if (method === "Target.attachToTarget") return { sessionId: "tab-1" };
    return {};
  } });
  const focus = calls.findIndex(x => x.method === "Emulation.setFocusEmulationEnabled");
  assert.ok(focus > 0 && focus < calls.findIndex(x => x.method === "Page.enable"));
  assert.equal(calls[focus].params.enabled, true);
  assert.equal(calls[focus].sessionId, "tab-1");
  assert.equal(calls.some(x => ["Target.activateTarget", "Page.bringToFront"].includes(x.method)), false);
});

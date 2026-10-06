import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

function browser({ deferCreate = false } = {}) {
  const handlers = {};
  const commands = [];
  let owner = "conversation-a";
  let socketClosed = false;
  const ws = {
    readyState: 1,
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    send(raw) {
      const request = JSON.parse(raw);
      commands.push(request);
      if (request.method === "Runtime.pending") return;
      if (deferCreate && request.method === "Target.createTarget") return;
      queueMicrotask(() => emit("message", { data: JSON.stringify({ id: request.id, result: { ok: true } }) }));
    },
    close() { socketClosed = true; emit("close"); },
  };
  function emit(name, value) { for (const fn of handlers[name] || []) fn(value); }
  const source = readFileSync(new URL("../lib/browser.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "")
    + "\nglobalThis.api = { openCaptureSession, exclusive, pages };";
  const context = {
    currentOwner: () => owner, connectBridge: async () => ws,
    randomUUID: () => "fixture-id", setTimeout, clearTimeout, AbortController, AbortSignal,
    WebSocket: { OPEN: 1, CONNECTING: 0 },
  };
  vm.runInNewContext(source, context);
  return { ...context.api, commands, emit, setOwner(value) { owner = value; }, socketClosed: () => socketClosed };
}

test("capture commands retain an isolated owner when caller context changes", async () => {
  const api = browser();
  const conversation = { targetId: "conversation-tab" };
  api.pages.set("conversation-a", conversation);
  const session = await api.openCaptureSession();
  api.setOwner("conversation-b");
  const params = { expression: "1", dshOwner: "foreign" };
  await session.cdp.send("Runtime.evaluate", params, "capture-tab");
  await session.cdp.send("Target.createTarget", { url: "about:blank" });
  await session.close();
  assert.match(api.commands[0].params.dshOwner, /^capture:conversation-a:/);
  assert.equal(new Set(api.commands.map((command) => command.params.dshOwner)).size, 1);
  assert.equal(params.dshOwner, "foreign");
  assert.equal(api.pages.get("conversation-a"), conversation);
  assert.equal(api.socketClosed(), false);
});

test("closing a capture removes listeners, cancels waits and releases the queue", async () => {
  const api = browser();
  const session = await api.openCaptureSession();
  let events = 0;
  session.cdp.onEvent(() => events++);
  const waiting = assert.rejects(session.cdp.waitForEvent("Page.loadEventFired", { sessionId: "capture-tab" }), /cancelled|closed/);
  const pending = assert.rejects(session.cdp.send("Runtime.pending", {}, "capture-tab"), /cancelled|closed/);
  const next = api.exclusive(async () => "next job");
  await session.close();
  await Promise.all([waiting, pending]);
  assert.equal(await next, "next job");
  api.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "capture-tab" }) });
  assert.equal(events, 0);
  await assert.rejects(session.cdp.send("Runtime.evaluate"), /closed/);
  await session.close();
  assert.equal(api.commands.filter((command) => command.method === "Browser.close").length, 1);
});

test("abort cleans only the capture owner and releases the queue without caller cleanup", async () => {
  const api = browser();
  const controller = new AbortController();
  const session = await api.openCaptureSession(controller.signal);
  await session.cdp.send("Target.createTarget", { url: "about:blank" });
  const next = api.exclusive(async () => "after abort");
  controller.abort();
  assert.equal(await next, "after abort");
  assert.equal(api.commands.at(-1).method, "Browser.close");
  assert.match(api.commands.at(-1).params.dshOwner, /^capture:conversation-a:/);
  assert.equal(api.socketClosed(), false);
});

test("abort rejects a queued capture promptly without releasing another capture", async () => {
  const api = browser();
  const first = await api.openCaptureSession();
  const controller = new AbortController();
  const cancelled = assert.rejects(api.openCaptureSession(controller.signal), /cancelled/);
  controller.abort();
  await cancelled;
  assert.equal(api.commands.length, 0);
  await first.close();
  assert.equal(await api.exclusive(async () => "queue usable"), "queue usable");
});

test("bridge disconnect cancels waits and releases capture queue", async () => {
  const api = browser();
  const session = await api.openCaptureSession();
  const waiting = assert.rejects(session.cdp.waitForEvent("Page.loadEventFired"), /cancelled|closed/);
  const next = api.exclusive(async () => "after disconnect");
  api.emit("close");
  await waiting;
  assert.equal(await next, "after disconnect");
  assert.equal(api.commands.length, 0);
});

test("abort waits for late tab creation before closing its isolated group", async () => {
  const api = browser({ deferCreate: true });
  const controller = new AbortController();
  const session = await api.openCaptureSession(controller.signal);
  const created = session.cdp.send("Target.createTarget", { url: "about:blank" }, undefined, { signal: controller.signal });
  let nextStarted = false;
  const next = api.exclusive(async () => { nextStarted = true; });
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextStarted, false);
  assert.deepEqual(api.commands.map((command) => command.method), ["Target.createTarget"]);
  api.emit("message", { data: JSON.stringify({ id: api.commands[0].id, result: { targetId: "late-capture-tab" } }) });
  assert.equal((await created).targetId, "late-capture-tab");
  await next;
  assert.equal(api.commands.at(-1).method, "Browser.close");
});

test("explicit close reports group cleanup failures and still releases its queue", async () => {
  const api = browser();
  const session = await api.openCaptureSession();
  const next = api.exclusive(async () => "released after failure");
  const closing = session.close();
  await Promise.resolve();
  const closeCommand = api.commands.at(-1);
  api.emit("message", { data: JSON.stringify({ id: closeCommand.id, error: { message: "cleanup denied" } }) });
  await assert.rejects(closing, /cleanup denied/);
  assert.equal(await next, "released after failure");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { browserExecutionVersions, extensionExecution, validateExtensionEngine } from "../lib/execution.js";
import { engine } from "./fixtures/engine.mjs";

function browser({ deferCreate = false, failCloseOnce = false, deferClose = false, fastTimers = false, workerGeneration = "fixture-worker-1" } = {}) {
  const handlers = {};
  const commands = [];
  let owner = "conversation-a";
  let socketClosed = false;
  let connections = 0;
  const ws = {
    hello: { engine: { ...engine, workerGeneration } },
    readyState: 1,
    addEventListener(name, fn) { (handlers[name] ||= []).push(fn); },
    send(raw) {
      const request = JSON.parse(raw);
      commands.push(request);
      if (request.method === "Runtime.pending") return;
      if (deferCreate && request.method === "Target.createTarget") return;
      if (deferClose && request.method === "Browser.close") return;
      if (failCloseOnce && request.method === "Browser.close") {
        failCloseOnce = false;
        queueMicrotask(() => emit("message", { data: JSON.stringify({ id: request.id, error: { message: "cleanup denied" } }) }));
        return;
      }
      const result = request.method === "Target.attachToTarget" ? { sessionId: request.params.targetId } : { ok: true };
      queueMicrotask(() => emit("message", { data: JSON.stringify({ id: request.id, result }) }));
    },
    close() { socketClosed = true; emit("close"); },
  };
  function emit(name, value) { for (const fn of handlers[name] || []) fn(value); }
  const source = readFileSync(new URL("../lib/browser.js", import.meta.url), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "")
    + "\nglobalThis.api = { openCaptureSession, exclusive, ensureBridge, shutdown, pages };";
  const context = {
    browserExecutionVersions, extensionExecution, validateExtensionEngine,
    currentOwner: () => owner, connectBridge: async () => { connections++; return ws; },
    randomUUID: () => "fixture-id", setTimeout: (fn, ms) => setTimeout(fn, fastTimers ? Math.min(ms, 10) : ms), clearTimeout, AbortController, AbortSignal,
    WebSocket: { OPEN: 1, CONNECTING: 0 },
  };
  vm.runInNewContext(source, context);
  return { ...context.api, commands, emit, setOwner(value) { owner = value; }, allowClose() { deferClose = false; }, setWorkerGeneration(value) { ws.hello.engine.workerGeneration = value; }, socketClosed: () => socketClosed, connections: () => connections };
}

test("strict headless capture rejects before connecting, queuing or creating tabs", async () => {
  const api = browser();
  await assert.rejects(api.openCaptureSession(undefined, { execution: {
    scope: { sessionId: "conversation-a", taskId: "headless-capture" },
    purpose: "web-regression", mode: "headless", ownership: "borrowed-connection", capabilities: ["dom"],
  } }), { code: "BROWSER_MODE_MISMATCH" });
  assert.equal(api.connections(), 0);
  assert.equal(api.commands.length, 0);
});

test("capture reports its validated borrowed engine and exact operation scope", async () => {
  const api = browser();
  const session = await api.openCaptureSession(undefined, { execution: {
    scope: { sessionId: "conversation-a", taskId: "capture-batch" },
    purpose: "capture", mode: "headed", ownership: "borrowed-connection", capabilities: ["dom", "authenticated-state"],
  } });
  assert.equal(session.backend, "chrome-extension");
  assert.equal(session.execution.scope.taskId, "capture-batch");
  assert.equal(session.execution.mode, "headed");
  assert.equal(session.engine.browserVersion, "1.2.3.4");
  await session.close();
});

test("capture commands retain an isolated owner when caller context changes", async () => {
  const api = browser();
  // A cached conversation page belongs to an already established transport.
  const cdp = await api.exclusive(active => api.ensureBridge(active));
  const conversation = { targetId: "conversation-tab", cdp };
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
  const api = browser({ failCloseOnce: true });
  const session = await api.openCaptureSession();
  const next = api.exclusive(async () => "released after failure");
  const closing = session.close();
  await assert.rejects(closing, /cleanup denied/);
  assert.equal(await next, "released after failure");
});

test("T5 owner B can capture while owner A holds its own capture queue", async () => {
  const api = browser();
  const a = await api.openCaptureSession();
  api.setOwner("conversation-b");
  let bReady = false;
  const openingB = api.openCaptureSession().then(session => { bReady = true; return session; });
  await new Promise(resolve => setImmediate(resolve));
  const independent = bReady;
  await a.close();
  const b = await openingB;
  await b.close();
  assert.equal(independent, true, "an unrelated owner must not wait behind a global capture lock");
  assert.equal(api.connections(), 1, "owners share one actual bridge, not competing controller sockets");
});

test("T5 closing ordinary owner A does not disconnect owner B's live capture", async () => {
  const api = browser();
  api.setOwner("conversation-b");
  const b = await api.openCaptureSession();
  api.setOwner("conversation-a");
  await api.shutdown();
  const disconnectedByA = api.socketClosed();
  await b.close();
  assert.equal(disconnectedByA, false, "absence of ordinary cached pages does not make B's capture connection disposable");
});

test("T5 a crashed bridge cannot acknowledge capture cleanup without evidence", async () => {
  const api = browser();
  const session = await api.openCaptureSession();
  api.emit("close");
  await assert.rejects(session.close(), { code: "CHROME_CLEANUP_PENDING" });
  assert.equal(session.cleanup.state, "retained");
  assert.match(session.cleanup.owner, /^capture:conversation-a:/);
});

test("T5 failed capture cleanup is observable and an explicit same-session retry can succeed", async () => {
  const api = browser({ failCloseOnce: true });
  const session = await api.openCaptureSession();
  await assert.rejects(session.close(), /cleanup denied/);
  assert.equal(session.cleanup.state, "retained");
  await session.close();
  assert.equal(session.cleanup.state, "closed");
  assert.equal(api.commands.filter(command => command.method === "Browser.close").length, 2);
});

test("T5 create timeout and missing close ACK have a bounded retained failure and explicit retry", async () => {
  const api = browser({ deferCreate: true, deferClose: true, fastTimers: true });
  const session = await api.openCaptureSession();
  await assert.rejects(session.cdp.send("Target.createTarget", { url: "about:blank" }, undefined, { timeoutMs: 2 }), /timed out/);
  const started = Date.now();
  await assert.rejects(session.close(), { code: "CHROME_CLEANUP_PENDING" });
  assert.ok(Date.now() - started < 1000, "test-dilated cleanup timers must bound the missing ACK");
  const retained = session.cleanup;
  assert.equal(retained.state, "retained");
  const created = api.commands.find(command => command.method === "Target.createTarget");
  api.emit("message", { data: JSON.stringify({ id: created.id, result: { targetId: "tab-late" } }) });
  api.allowClose();
  await session.close();
  assert.equal(api.commands.filter(command => command.method === "Browser.close").length, 2, "an explicit retry actually reaches the worker; it is not a cached fulfilled close");
  assert.equal(session.cleanup.state, "closed");
});

test("T5 capture events and unqualified waits cannot consume another owner's CDP events", async () => {
  const api = browser();
  const a = await api.openCaptureSession();
  await a.cdp.send("Target.attachToTarget", { targetId: "tab-a" });
  api.setOwner("conversation-b");
  const b = await api.openCaptureSession();
  await b.cdp.send("Target.attachToTarget", { targetId: "tab-b" });
  const aEvents = [], bEvents = [];
  a.cdp.onEvent(event => aEvents.push(event.sessionId));
  b.cdp.onEvent(event => bEvents.push(event.sessionId));
  let aLoaded = false;
  const waiting = a.cdp.waitForEvent("Page.loadEventFired").then(value => { aLoaded = true; return value; });
  api.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "tab-b", params: { marker: "b" } }) });
  await new Promise(resolve => setImmediate(resolve));
  const consumedForeign = aLoaded;
  api.emit("message", { data: JSON.stringify({ method: "Page.loadEventFired", sessionId: "tab-a", params: { marker: "a" } }) });
  assert.equal((await waiting).marker, "a");
  await Promise.all([a.close(), b.close()]);
  assert.equal(consumedForeign, false);
  assert.deepEqual(aEvents, ["tab-a"]);
  assert.deepEqual(bEvents, ["tab-b"]);
});

test("T5 connection loss is reported before an explicit retry reconnects and proves cleanup", async () => {
  const api = browser();
  const session = await api.openCaptureSession();
  api.emit("close");
  assert.equal(api.connections(), 1, "a crash does not automatically reconnect");
  await assert.rejects(session.close(), { code: "CHROME_CLEANUP_PENDING" });
  assert.equal(api.connections(), 1, "the known missing ACK must be visible, not replaced by an implicit retry");
  await session.close();
  assert.equal(api.connections(), 2);
  assert.equal(api.commands.filter(command => command.method === "Browser.close").length, 1);
  assert.equal(session.cleanup.state, "closed");
});

for (const nextGeneration of ["fixture-worker-1", "fixture-worker-2", undefined]) {
  test(`T5 lost unacknowledged create reconciles only with its exact worker generation: ${nextGeneration ?? "missing"}`, async () => {
    const api = browser({ deferCreate: true });
    const a = await api.openCaptureSession();
    const creating = a.cdp.send("Target.createTarget", { url: "about:blank" });
    const rejected = assert.rejects(creating, /connection closed/);
    const create = api.commands.at(-1);
    api.emit("close");
    await rejected;
    const unknown = a.cleanup.unconfirmedCreates[0];
    assert.equal(unknown.owner, create.params.dshOwner);
    assert.equal(unknown.requestId, create.id);
    assert.equal(unknown.workerGeneration, "fixture-worker-1");
    assert.equal(unknown.scope.sessionId, a.execution.scope.sessionId);
    assert.equal(unknown.scope.taskId, a.execution.scope.taskId);
    assert.ok(unknown.disconnectedAt >= unknown.startedAt);
    await assert.rejects(a.close(), { code: "CHROME_CLEANUP_PENDING" });
    api.setWorkerGeneration(nextGeneration);
    api.setOwner("conversation-b");
    const b = await api.openCaptureSession();
    if (nextGeneration === "fixture-worker-1") {
      await a.close();
      assert.equal(a.cleanup.state, "closed");
      assert.equal(a.cleanup.unconfirmedCreates, undefined);
    } else {
      await assert.rejects(a.close(), error => error.code === "CHROME_CLEANUP_PENDING" && /generation changed or is unavailable/.test(error.message));
      assert.equal(a.cleanup.state, "retained");
      assert.equal(a.cleanup.unconfirmedCreates[0], unknown, "a new empty ledger/ACK cannot erase the old unknown creation");
    }
    assert.equal(api.commands.filter(command => command.method === "Browser.close" && command.params.dshOwner === unknown.owner).length, 1, "known own resources are still closed using the exact retained owner");
    await b.cdp.send("Runtime.evaluate", { expression: "1" });
    assert.equal(api.socketClosed(), false);
    await b.close();
  });
}

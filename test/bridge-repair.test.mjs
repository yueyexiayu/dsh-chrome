import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFrameParser, encodeFrame } from "../lib/frame.js";
import { socketPaths } from "../lib/install.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clientSource = fs.readFileSync(path.join(root, "lib/bridge-client.js"), "utf8")
  .replace(/^import .*;\n/gm, "").replace(/^export /gm, "");
function clientApi(overrides = {}) {
  const context = vm.createContext({ net, createFrameParser, encodeFrame, setTimeout, clearTimeout,
    installNativeHost: async () => {}, installMessage: () => "not connected", socketPaths: () => [], ...overrides });
  vm.runInContext(`${clientSource}\nglobalThis.api = { BridgeLink, hello, waitForSocket, connectBridge };`, context);
  return context.api;
}
class Socket extends EventEmitter {
  destroyed = false;
  write() {}
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit("close"));
  }
}

test("hello rejects socket error and keeps an error handler after rejection", async () => {
  const { BridgeLink, hello } = clientApi();
  const socket = new Socket();
  const link = new BridgeLink(socket);
  socket.write = () => setImmediate(() => socket.emit("error", new Error("ECONNRESET during hello")));
  await assert.rejects(hello(link), /ECONNRESET/);
  assert.equal(socket.destroyed, true);
  assert.equal(link.handlers.message.size, 0);
  assert.equal(link.handlers.error.size, 0);
  assert.doesNotThrow(() => socket.emit("error", new Error("late reset")));
});

test("hello rejects close, abort, malformed frames and protocol mismatch without waiting for timeout", async () => {
  for (const failure of ["close", "abort", "malformed", "protocol"]) {
    const { BridgeLink, hello } = clientApi();
    const socket = new Socket();
    const link = new BridgeLink(socket);
    const abort = new AbortController();
    const request = hello(link, abort.signal);
    if (failure === "close") socket.destroy();
    if (failure === "abort") abort.abort();
    if (failure === "malformed") socket.emit("data", Buffer.from([1, 0, 0, 0, 123]));
    if (failure === "protocol") socket.emit("data", encodeFrame({ id: 1, result: { ok: true, protocolVersion: 1 } }));
    await assert.rejects(request);
    assert.equal(socket.destroyed, true);
    for (const handlers of Object.values(link.handlers)) assert.equal(handlers.size, 0);
  }
});

test("hello success retains permanent socket error handling", async () => {
  const { BridgeLink, hello } = clientApi();
  const socket = new Socket();
  const link = new BridgeLink(socket);
  socket.write = () => socket.emit("data", encodeFrame({ id: 1, result: { ok: true, protocolVersion: 2 } }));
  assert.equal(await hello(link), link);
  assert.equal(link.handlers.message.size, 0);
  assert.doesNotThrow(() => socket.emit("error", new Error("reset after hello")));
  assert.equal(link.readyState, 3);
});

test("connect-to-hello transition has no unhandled error window", async () => {
  const socket = new Socket();
  const api = clientApi({ socketPaths: () => ["/mock/dsh-c-12345678"], net: { connect() {
    setImmediate(() => { socket.emit("connect"); socket.emit("error", new Error("transition reset")); });
    return socket;
  } }, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 50)) });
  await assert.rejects(api.connectBridge());
  assert.equal(socket.destroyed, true);
});

test("connect is bounded and abortable even when net.connect never emits", async () => {
  for (const aborted of [true, false]) {
    const socket = new Socket();
    const api = clientApi({ socketPaths: () => ["/mock/dsh-c-12345678"], net: { connect: () => socket },
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 30)) });
    const controller = new AbortController();
    const pending = api.waitForSocket(controller.signal);
    if (aborted) controller.abort();
    await assert.rejects(pending, aborted ? /cancelled/ : /not connected/);
    assert.equal(socket.destroyed, true);
  }
});

test("legacy discovery refuses without connecting to or evicting the old host", async () => {
  let connections = 0;
  const api = clientApi({ socketPaths: () => ["/mock/dsh-chrome.sock"], net: { connect() { connections++; } } });
  await assert.rejects(api.waitForSocket(), /legacy DSH Chrome socket/);
  assert.equal(connections, 0);
});

function frames(stream) {
  const queue = [];
  const parser = createFrameParser(message => queue.push(message));
  stream.on("data", chunk => parser.push(chunk));
  return { queue, async next() {
    for (let i = 0; i < 300; i++) {
      if (queue.length) return queue.shift();
      await delay(10);
    }
    throw new Error("expected frame");
  } };
}
function fixture(t) {
  const home = fs.mkdtempSync("/tmp/chrome-repair-");
  const children = [], sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(children.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exit;
    }));
    assert.equal(path.dirname(home), "/tmp");
    assert.match(path.basename(home), /^chrome-repair-/);
    fs.rmSync(home, { recursive: true, force: true });
  });
  function start() {
    const child = spawn(process.execPath, [path.join(root, "host/bridge.mjs")], {
      env: { ...process.env, DSH_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    const host = { child, output: frames(child.stdout), errors: "" };
    child.stderr.on("data", chunk => { host.errors += chunk; });
    children.push(host);
    return host;
  }
  async function connect(endpoint) {
    const socket = net.connect(endpoint);
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return socket;
  }
  async function endpoint(exclude = []) {
    for (let i = 0; i < 300; i++) {
      const result = socketPaths(home).find(item => !exclude.includes(item));
      if (result) return result;
      await delay(10);
    }
    throw new Error("no native endpoint");
  }
  return { home, start, connect, endpoint };
}

test("second DSH client receives BRIDGE_BUSY and cannot evict the first", { timeout: 10000 }, async t => {
  const f = fixture(t), h = f.start();
  const endpoint = await f.endpoint();
  const first = await f.connect(endpoint), firstFrames = frames(first);
  first.write(encodeFrame({ id: 1, method: "DSH.hello" }));
  const request = await h.output.next();
  const second = await f.connect(endpoint), secondFrames = frames(second);
  second.write(encodeFrame({ id: 99, method: "DSH.hello" }));
  const rejected = await secondFrames.next();
  assert.equal(rejected.id, 99);
  assert.equal(rejected.error.code, "BRIDGE_BUSY");
  assert.equal(first.destroyed, false);
  h.child.stdin.write(encodeFrame({ id: request.id, result: { ok: true } }));
  assert.deepEqual(await firstFrames.next(), { id: 1, result: { ok: true } });
  assert.equal(h.output.queue.length, 0);
});

test("second native host reports profile conflict and preserves active endpoint/controller", { timeout: 10000 }, async t => {
  const f = fixture(t), first = f.start();
  const endpoint = await f.endpoint(), inode = fs.statSync(endpoint).ino;
  const socket = await f.connect(endpoint), replies = frames(socket);
  socket.write(encodeFrame({ id: 1, method: "DSH.hello" }));
  const request = await first.output.next();
  const second = f.start();
  const conflict = await second.output.next();
  assert.equal(conflict.method, "DSH.bridgeConflict");
  assert.match(conflict.params.message, /Another Chrome profile/);
  assert.equal(fs.statSync(endpoint).ino, inode);
  assert.equal(first.child.exitCode, null);
  assert.equal(socket.destroyed, false);
  first.child.stdin.write(encodeFrame({ id: request.id, result: { preserved: true } }));
  assert.deepEqual(await replies.next(), { id: 1, result: { preserved: true } });
});

test("simultaneous native hosts never replace an endpoint or silently coexist", { timeout: 10000 }, async t => {
  const f = fixture(t), hosts = [f.start(), f.start()];
  for (let i = 0; i < 300 && hosts.every(h => h.child.exitCode === null); i++) await delay(10);
  assert.ok(hosts.some(h => h.child.exitCode === 1));
  assert.ok(hosts.some(h => h.output.queue.some(frame => frame.method === "DSH.bridgeConflict")));
  assert.ok(socketPaths(f.home).length <= 1);
});

test("SIGKILL stale endpoint is ignored without unlink and a new host can serve", { timeout: 10000 }, async t => {
  const f = fixture(t), first = f.start();
  const stale = await f.endpoint();
  const killed = new Promise(resolve => first.child.once("exit", resolve));
  first.child.kill("SIGKILL");
  await killed;
  assert.equal(fs.statSync(stale).isSocket(), true);
  const second = f.start(), endpoint = await f.endpoint([stale]);
  const socket = await f.connect(endpoint);
  socket.write(encodeFrame({ id: 42, method: "DSH.hello" }));
  assert.equal((await second.output.next()).method, "DSH.hello");
  assert.equal(fs.existsSync(stale), true);
  assert.equal(fs.statSync(endpoint).mode & 0o777, 0o600);
});

test("real host and client complete hello without running the real installer", { timeout: 10000 }, async t => {
  const f = fixture(t), h = f.start();
  const api = clientApi({ socketPaths: () => socketPaths(f.home) });
  const connected = api.connectBridge();
  const hello = await h.output.next();
  assert.equal(hello.method, "DSH.hello");
  h.child.stdin.write(encodeFrame({ id: hello.id, result: { ok: true, protocolVersion: 2 } }));
  const link = await connected;
  t.after(() => link.close());
  const second = api.connectBridge();
  await assert.rejects(second, /already controlled by another DSH process/);
  assert.equal(link.readyState, 1);
  link.close();
  const endpoint = await f.endpoint();
  const exited = new Promise(resolve => h.child.once("exit", resolve));
  h.child.stdin.end();
  await exited;
  assert.equal(fs.existsSync(endpoint), false);
});

test("native host refuses legacy sockets without probing or unlinking them", { timeout: 10000 }, async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, "cache"));
  const endpoint = path.join(f.home, "cache", "dsh-chrome.sock");
  let accepted = 0;
  const server = net.createServer(socket => { accepted++; socket.destroy(); });
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(() => server.close());
  const inode = fs.statSync(endpoint).ino;
  const h = f.start();
  const conflict = await h.output.next();
  assert.equal(conflict.method, "DSH.bridgeConflict");
  assert.match(conflict.params.message, /legacy DSH Chrome socket/);
  assert.equal(accepted, 0);
  assert.equal(fs.statSync(endpoint).ino, inode);
});

test("client detects multiple live endpoints rather than choosing a profile", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, "cache"));
  const endpoints = ["dsh-c-11111111", "dsh-c-22222222"].map(name => path.join(f.home, "cache", name));
  const servers = endpoints.map(() => net.createServer(socket => { t.after(() => socket.destroy()); }));
  for (let i = 0; i < servers.length; i++) {
    await new Promise(resolve => servers[i].listen(endpoints[i], resolve));
    t.after(() => servers[i].close());
  }
  const api = clientApi({ socketPaths: () => socketPaths(f.home) });
  await assert.rejects(api.waitForSocket(), /Multiple Chrome profiles/);
});

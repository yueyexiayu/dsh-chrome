import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createFrameParser, encodeFrame } from "../lib/frame.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function frames(stream) {
  const queue = [];
  const parser = createFrameParser((message) => queue.push(message));
  stream.on("data", (chunk) => parser.push(chunk));
  return {
    queue,
    async next() {
      const until = Date.now() + 3000;
      while (!queue.length && Date.now() < until) await sleep(10);
      assert.ok(queue.length, "expected a protocol frame within three seconds");
      return queue.shift();
    },
  };
}

async function connect(sock) {
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.connect(sock);
        socket.once("connect", () => resolve(socket));
        socket.once("error", (error) => { socket.destroy(); reject(error); });
      });
    } catch { await sleep(20); }
  }
  throw new Error("temporary native host socket did not start");
}

function host(t, home) {
  const child = spawn(process.execPath, [path.join(root, "host/bridge.mjs")], {
    env: { ...process.env, DSH_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await exited;
    rmSync(home, { recursive: true, force: true });
  });
  return { child, output: frames(child.stdout), sock: path.join(home, "cache/dsh-chrome.sock") };
}

test("a late response from the replaced connection cannot resolve a new client's reused id", { timeout: 10000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "chrome-reconnect-"));
  const h = host(t, home);
  const old = await connect(h.sock);
  old.on("error", () => {});
  t.after(() => old.destroy());
  old.write(encodeFrame({ id: 1, method: "DSH.hello" }));
  const first = await h.output.next();
  const current = await connect(h.sock);
  t.after(() => current.destroy());
  const responses = frames(current);
  current.write(encodeFrame({ id: 1, method: "DSH.hello" }));
  const second = await h.output.next();
  assert.notEqual(first.id, second.id);
  h.child.stdin.write(encodeFrame({ id: first.id, result: { stale: true } }));
  await sleep(50);
  assert.equal(responses.queue.length, 0);
  h.child.stdin.write(encodeFrame({ id: second.id, result: { fresh: true } }));
  assert.deepEqual(await responses.next(), { id: 1, result: { fresh: true } });
  h.child.stdin.write(encodeFrame({ id: second.id, result: { duplicate: true } }));
  await sleep(50);
  assert.equal(responses.queue.length, 0);
});

test("the host returns an explicit save error with the original mark request id", { timeout: 10000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "chrome-save-error-"));
  mkdirSync(path.join(home, "cache"));
  writeFileSync(path.join(home, "cache/dsh-chrome-marks"), "blocked-directory");
  const h = host(t, home);
  const socket = await connect(h.sock);
  t.after(() => socket.destroy());
  h.child.stdin.write(encodeFrame({ id: "mark:failure", method: "DSH.mark", params: { url: "https://example.com", image: "aGVsbG8=" } }));
  const response = await h.output.next();
  assert.equal(response.id, "mark:failure");
  assert.equal(response.result, undefined);
  assert.match(response.error.message, /EEXIST|ENOTDIR/);
});

test("unanswered native requests expire after 60 seconds and their late replies are discarded", () => {
  const timers = new Map();
  const nativeFrames = [];
  const replies = [];
  const stdinListeners = {};
  let accept;
  let nextTimer = 0;
  const context = vm.createContext({
    fs: { mkdirSync() {}, unlinkSync() {}, chmodSync() {} },
    net: { createServer(fn) { accept = fn; return { listen(_sock, fn) { fn(); }, on() {} }; } },
    os: { homedir() { return "/mock-home"; } }, path,
    randomBytes() { return Buffer.alloc(16); }, createFrameParser, encodeFrame,
    saveMark() { throw new Error("unexpected mark write"); },
    process: {
      env: { DSH_HOME: "/mock-home" },
      stdin: { on(name, fn) { stdinListeners[name] = fn; } },
      stdout: { write(frame) { createFrameParser((message) => nativeFrames.push(message)).push(frame); } },
      stderr: { write(message) { throw new Error(message); } },
      exit() { throw new Error("unexpected host exit"); },
    },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = readFileSync(path.join(root, "host/bridge.mjs"), "utf8").replace(/^import .*;\n/gm, "");
  vm.runInContext(`${source}\nglobalThis.pendingCount = () => pending.size;`, context);
  const handlers = {};
  const socket = {
    destroyed: false, on(name, fn) { handlers[name] = fn; },
    write(frame) { createFrameParser((message) => replies.push(message)).push(frame); },
    destroy() { this.destroyed = true; },
  };
  accept(socket);
  handlers.data(encodeFrame({ id: 1, method: "DSH.hello" }));
  assert.equal(context.pendingCount(), 1);
  assert.equal(timers.size, 1);
  const timer = [...timers.values()][0];
  assert.equal(timer.ms, 60_000);
  timer.fn();
  assert.equal(context.pendingCount(), 0);
  stdinListeners.data(encodeFrame({ id: nativeFrames[0].id, result: { stale: true } }));
  assert.equal(replies.length, 0);
});

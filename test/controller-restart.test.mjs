import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFrameParser, encodeFrame } from "../lib/frame.js";
import { socketPaths } from "../lib/install.js";

const hostPath = fileURLToPath(new URL("../host/bridge.mjs", import.meta.url));
const firstToken = "ab".repeat(32);
const restartedToken = "cd".repeat(32);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function frames(stream) {
  const queue = [];
  stream.on("data", data => createParser.push(data));
  const createParser = createFrameParser(message => queue.push(message));
  return { queue, async next() {
    const deadline = Date.now() + 1000;
    while (!queue.length && Date.now() < deadline) await delay(5);
    assert.ok(queue.length, "expected an admitted controller protocol frame within 1 second");
    return queue.shift();
  } };
}
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "chrome-controller-restart-"));
  const child = spawn(process.execPath, [hostPath], {
    env: { ...process.env, DSH_HOME: home, DSH_CHROME_ALLOW_NODE_PEER: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", data => { errors += data; });
  const output = frames(child.stdout);
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise(resolve => child.once("exit", resolve));
      child.kill(); await exit;
    }
    assert.equal(path.dirname(home), os.tmpdir().replace(/\/$/, ""));
    assert.match(path.basename(home), /^chrome-controller-restart-/);
    await rm(home, { recursive: true, force: true });
  });
  let endpoint;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !endpoint) { endpoint = socketPaths(home)[0]; if (!endpoint) await delay(5); }
  assert.ok(endpoint, `isolated native endpoint missing: ${errors}`);
  async function connect(token) {
    const socket = net.connect(endpoint);
    sockets.push(socket); socket.on("error", () => {});
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const replies = frames(socket);
    socket.write(encodeFrame({ method: "DSH.auth", token }));
    return { socket, replies, request(id, method = "DSH.hello") { socket.write(encodeFrame({ id, method })); } };
  }
  async function close(controller) {
    if (controller.socket.destroyed) return;
    const closed = new Promise(resolve => controller.socket.once("close", resolve));
    controller.socket.destroy(); await closed; await delay(20);
  }
  async function ack(controller, expected) {
    const request = await output.next();
    assert.equal(request.method, "DSH.hello");
    child.stdin.write(encodeFrame({ id: request.id, result: { ok: true, protocolVersion: 2 } }));
    assert.deepEqual(await controller.replies.next(), { id: expected, result: { ok: true, protocolVersion: 2 } });
    return request;
  }
  return { home, child, output, connect, close, ack };
}

test("a restarted DSH controller with a fresh token can reuse the surviving Native Host", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const old = await f.connect(firstToken); old.request(1); await f.ack(old, 1);
  await f.close(old);
  const current = await f.connect(restartedToken); current.request(1); await f.ack(current, 1);
  assert.equal(f.child.exitCode, null);
  assert.equal(current.socket.destroyed, false);
});
test("an auth-only connection cannot pin the controller token or evict its later owner", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const probe = await f.connect(firstToken);
  const current = await f.connect(restartedToken); current.request(1); await f.ack(current, 1);
  probe.request(2);
  const busy = await probe.replies.next();
  assert.equal(busy.error.code, "BRIDGE_BUSY");
  assert.equal(current.socket.destroyed, false);
  assert.equal(f.output.queue.length, 0);
  current.request(3); await f.ack(current, 3);
});
test("closing an auth-only candidate permits a subsequent different-token controller", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const probe = await f.connect(firstToken); await delay(20); await f.close(probe);
  const current = await f.connect(restartedToken); current.request(1); await f.ack(current, 1);
});
test("live controller rejects both foreign-token and same-token competitors without eviction", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const owner = await f.connect(firstToken); owner.request(1); await f.ack(owner, 1);
  const foreign = await f.connect(restartedToken);
  const foreignClosed = new Promise((resolve, reject) => {
    if (foreign.socket.destroyed) return resolve();
    const timer = setTimeout(() => reject(new Error("foreign token did not close")), 1000);
    foreign.socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
  foreign.request(2); await foreignClosed;
  const duplicate = await f.connect(firstToken); duplicate.request(3);
  assert.equal((await duplicate.replies.next()).error.code, "BRIDGE_BUSY");
  owner.request(4); await f.ack(owner, 4);
  assert.equal(owner.socket.destroyed, false);
  assert.equal(f.output.queue.length, 0);
});
test("new-token takeover still discards late old replies and keeps request ids isolated", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const old = await f.connect(firstToken); old.request(1);
  const oldRequest = await f.output.next(); await f.close(old);
  const current = await f.connect(restartedToken); current.request(1);
  const newRequest = await f.output.next();
  assert.notEqual(newRequest.id, oldRequest.id);
  f.child.stdin.write(encodeFrame({ id: oldRequest.id, result: { stale: true } }));
  await delay(40); assert.equal(current.replies.queue.length, 0);
  f.child.stdin.write(encodeFrame({ id: newRequest.id, result: { fresh: true } }));
  assert.deepEqual(await current.replies.next(), { id: 1, result: { fresh: true } });
});
test("an early-authenticated candidate can claim only after the intervening controller releases", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const candidate = await f.connect(restartedToken);
  const intervening = await f.connect(firstToken); intervening.request(1); await f.ack(intervening, 1);
  await f.close(intervening);
  candidate.request(1); await f.ack(candidate, 1);
  const competitor = await f.connect(restartedToken); competitor.request(2);
  assert.equal((await competitor.replies.next()).error.code, "BRIDGE_BUSY");
  candidate.request(3); await f.ack(candidate, 3);
  assert.equal(candidate.socket.destroyed, false);
});
test("closing an older auth-only candidate cannot clear the current admitted controller", { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const probe = await f.connect(firstToken);
  const current = await f.connect(firstToken); current.request(1); await f.ack(current, 1);
  await f.close(probe);
  const foreign = await f.connect(restartedToken); foreign.request(2);
  await delay(40); assert.equal(foreign.socket.destroyed, true);
  current.request(3); await f.ack(current, 3);
  assert.equal(current.socket.destroyed, false);
});

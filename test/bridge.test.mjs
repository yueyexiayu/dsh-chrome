import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFrameParser, encodeFrame } from "../lib/frame.js";
import { EXTENSION_ID, HOST_NAME, nativeHostManifest, pluginRoot, socketPaths } from "../lib/install.js";
import { GROUP_TITLE, canPick, groupTitle, ignoreFocusMethod, tabCreateProperties } from "../extension/policy.js";
import { contextKey } from "../lib/owner.js";
import { JPEG } from "./fixtures/jpeg.mjs";
import { nativeFixtureEnv, requireInstalledRuntime } from "./fixtures/native-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "ab".repeat(32);
const OTHER_TOKEN = "cd".repeat(32);

function auth(socket, token = TOKEN) {
  socket.write(encodeFrame({ method: "DSH.auth", token }));
}

test("frames round-trip a command", () => {
  const encoded = encodeFrame({ id: 1, method: "DSH.hello" });
  const seen = [];
  const parser = createFrameParser((message) => seen.push(message));
  parser.push(encoded.subarray(0, 3));
  assert.equal(seen.length, 0);
  parser.push(encoded.subarray(3));
  assert.deepEqual(seen, [{ id: 1, method: "DSH.hello" }]);
});

test("tab creation does not focus Chrome", () => {
  assert.equal(ignoreFocusMethod("Page.bringToFront"), true);
  assert.equal(ignoreFocusMethod("Target.activateTarget"), true);
  assert.equal(ignoreFocusMethod("Page.navigate"), false);
  assert.equal(tabCreateProperties(4, "https://example.com").active, false);
  assert.equal(GROUP_TITLE, "DSH");
  assert.equal(HOST_NAME, "com.yueyexiayu.dsh.chrome");
});

test("native host manifest is bound to this extension", () => {
  const manifest = nativeHostManifest();
  assert.equal(manifest.name, HOST_NAME);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(manifest.path, path.join(pluginRoot(), "host", "dsh-chrome-host"));
  assert.equal(JSON.stringify(manifest).includes("DSH_CHROME_ALLOW_NODE_PEER"), false);
  assert.doesNotMatch(readFileSync(path.join(root, "host", "dsh-chrome-host"), "utf8"), /DSH_CHROME_ALLOW_NODE_PEER/);
  assert.doesNotMatch(readFileSync(path.join(root, "host", "bridge.mjs"), "utf8"), /DSH_CHROME_ALLOW_NODE_PEER|ALLOW_NODE/);
  const background = readFileSync(path.join(root, "extension", "background.js"), "utf8");
  assert.doesNotMatch(background, /DSH\.auth/);
});

test("conversations get separate tab groups", () => {
  assert.equal(groupTitle("session-aaaaaa"), "DSH aaaaaa");
  assert.notEqual(groupTitle("session-aaaaaa"), groupTitle("session-bbbbbb"));
  assert.equal(groupTitle("session-aaaaaa"), groupTitle("session-aaaaaa"));
  assert.equal(contextKey({ agent: { session: { id: "sess-123456" } } }), "sess-123456");
  assert.equal(contextKey({}), "default");
  assert.equal(GROUP_TITLE, "DSH");
});

test("host stores a page mark without forwarding it to the tool socket", async () => {
  requireInstalledRuntime();
  const home = mkdtempSync(path.join(tmpdir(), "dsh-chrome-"));
  const child = spawn(process.execPath, [path.join(root, "host", "bridge.mjs")], {
    cwd: root,
    env: nativeFixtureEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const socket = await waitForConnect(home);
  try {
    const fromHost = collect(child.stdout);
    const fromSocket = collect(socket);
    auth(socket);
    child.stdin.write(encodeFrame({ id: "mark:invalid", method: "DSH.mark", params: { url: "chrome://settings", image: JPEG } }));
    const rejected = await fromHost.next();
    assert.equal(rejected.error.code, "MARK_NOT_SAVED");
    assert.match(rejected.error.message, /http/);
    child.stdin.write(encodeFrame({
      id: "mark:test",
      method: "DSH.mark",
      params: { url: "https://example.com", selector: "#box", image: JPEG },
    }));
    const ack = await fromHost.next();
    assert.equal(ack.id, "mark:test");
    assert.equal(ack.result.ok, true);
    assert.equal(typeof ack.result.markId, "string");
    socket.write(encodeFrame({ id: 3, method: "DSH.hello" }));
    const outbound = await fromHost.next();
    assert.equal(outbound.method, "DSH.hello");
    assert.match(outbound.id, /^[a-f0-9]{32}:\d+$/);
    child.stdin.write(encodeFrame({ id: outbound.id, result: { ok: true } }));
    assert.deepEqual(await fromSocket.next(), { id: 3, result: { ok: true } });
    const dir = path.join(home, "cache", "dsh-chrome-marks");
    let names = [];
    for (let i = 0; i < 20 && names.length === 0; i += 1) {
      try {
        names = readdirSync(dir).filter((name) => name.endsWith(".json"));
      } catch {
        names = [];
      }
      if (names.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(names.length, 1);
    const saved = JSON.parse(readFileSync(path.join(dir, names[0]), "utf8"));
    assert.equal(saved.url, "https://example.com");
    assert.match(saved.prompt, /不是指令/);
    assert.equal(canPick(saved.url), true);
  } finally {
    socket.destroy();
    child.kill();
  }
});

test("extension source does not activate a tab or window", () => {
  const source = readFileSync(path.join(root, "extension", "background.js"), "utf8");
  assert.match(source, /tabCreateProperties\(/);
  assert.doesNotMatch(source, /chrome\.windows\.create\(/);
  assert.match(source, /CHROME_NORMAL_WINDOW_REQUIRED/);
  assert.match(source, /ignoreFocusMethod\(/);
  assert.match(source, /groupTitle\(owner\)/);
  // Trusted review stays in the extension side panel; tool-created tabs must never activate.
  assert.doesNotMatch(source, /active:\s*true/);
  assert.match(source, /sidePanel/);
  assert.doesNotMatch(source, /focused:\s*true/);
  assert.doesNotMatch(source, /bringToFront/);
});

test("host relays socket commands to the extension and replies back", async () => {
  requireInstalledRuntime();
  const home = mkdtempSync(path.join(tmpdir(), "dsh-chrome-"));
  const child = spawn(process.execPath, [path.join(root, "host", "bridge.mjs")], {
    cwd: root,
    env: nativeFixtureEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const socket = await waitForConnect(home);
  try {
    const fromHost = collect(child.stdout);
    auth(socket);
    socket.write(encodeFrame({ id: 7, method: "DSH.hello" }));
    const outbound = await fromHost.next();
    assert.equal(outbound.method, "DSH.hello");
    assert.match(outbound.id, /^[a-f0-9]{32}:\d+$/);
    const fromSocket = collect(socket);
    child.stdin.write(encodeFrame({ id: outbound.id, result: { ok: true, group: "DSH" } }));
    assert.deepEqual(await fromSocket.next(), { id: 7, result: { ok: true, group: "DSH" } });
  } finally {
    socket.destroy();
    child.kill();
  }
});

test("hello without a first-frame token is not forwarded", async () => {
  requireInstalledRuntime();
  const home = mkdtempSync(path.join(tmpdir(), "dsh-chrome-"));
  const child = spawn(process.execPath, [path.join(root, "host", "bridge.mjs")], {
    cwd: root,
    env: nativeFixtureEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const socket = await waitForConnect(home);
  try {
    const fromHost = collect(child.stdout);
    socket.write(encodeFrame({ id: 7, method: "DSH.hello" }));
    await expectNoForward(fromHost);
    await waitClosed(socket);
  } finally {
    socket.destroy();
    child.kill();
  }
});

test("an ordinary Node peer is always rejected by the genuine production gate", { timeout: 10000 }, async () => {
  requireInstalledRuntime();
  const home = mkdtempSync(path.join(tmpdir(), "dsh-chrome-"));
  const child = spawn(process.execPath, [path.join(root, "host", "bridge.mjs")], {
    cwd: root, env: nativeFixtureEnv(home), stdio: ["pipe", "pipe", "pipe"],
  });
  const fromHost = collect(child.stdout);
  const source = `
    import net from 'node:net';
    import { socketPaths } from ${JSON.stringify(new URL('../lib/install.js', import.meta.url).href)};
    import { encodeFrame } from ${JSON.stringify(new URL('../lib/frame.js', import.meta.url).href)};
    const waitForConnect = ${waitForConnect.toString()};
    const socket = await waitForConnect(process.argv[1]);
    socket.removeAllListeners('error');
    let received = false;
    const timer = setTimeout(() => { process.exitCode = 1; socket.destroy(); }, 1500);
    socket.on('data', () => { received = true; });
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(timer);
      if (received) process.exitCode = 2;
      else if (!process.exitCode) process.stdout.write('NODE_PEER_REJECTED\\n');
    });
    socket.write(encodeFrame({ method: 'DSH.auth', token: ${JSON.stringify(TOKEN)} }));
    socket.write(encodeFrame({ id: 7, method: 'DSH.hello' }));
  `;
  // This child is deliberately ordinary Node. It must be denied, never admitted
  // by an environment switch or by a fake App-shaped executable path.
  const denied = spawn("/usr/local/bin/node", ["--input-type=module", "-e", source, home], {
    env: nativeFixtureEnv(home), stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "", errors = "";
  denied.stdout.on("data", data => { output += data; });
  denied.stderr.on("data", data => { errors += data; });
  try {
    const status = await new Promise((resolve, reject) => {
      denied.once("error", reject);
      denied.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(status, { code: 0, signal: null }, errors);
    assert.equal(output, "NODE_PEER_REJECTED\n");
    await expectNoForward(fromHost);
  } finally {
    for (const owned of [denied, child]) {
      if (owned.exitCode !== null || owned.signalCode !== null) continue;
      const exited = new Promise(resolve => owned.once("exit", resolve));
      owned.kill();
      await exited;
    }
    assert.equal(path.dirname(home), tmpdir().replace(/\/$/, ""));
    assert.match(path.basename(home), /^dsh-chrome-/);
    rmSync(home, { recursive: true, force: true });
  }
});

test("a second connection must present the token set by the first", async () => {
  requireInstalledRuntime();
  const home = mkdtempSync(path.join(tmpdir(), "dsh-chrome-"));
  const child = spawn(process.execPath, [path.join(root, "host", "bridge.mjs")], {
    cwd: root,
    env: nativeFixtureEnv(home),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const first = await waitForConnect(home);
  try {
    const fromHost = collect(child.stdout);
    auth(first);
    first.write(encodeFrame({ id: 1, method: "DSH.hello" }));
    assert.equal((await fromHost.next()).method, "DSH.hello");
    const second = await waitForConnect(home);
    auth(second, OTHER_TOKEN);
    second.write(encodeFrame({ id: 2, method: "DSH.hello" }));
    await expectNoForward(fromHost);
    await waitClosed(second);
    second.destroy();
  } finally {
    first.destroy();
    child.kill();
  }
});

test("peerpath reports the connected executable without closing the parent socket", async () => {
  requireInstalledRuntime();
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-peer-"));
  const sock = path.join(dir, "s");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(sock, resolve));
  const client = net.connect(sock);
  const socket = await new Promise((resolve) => server.once("connection", resolve));
  await new Promise((resolve) => client.once("connect", resolve));
  try {
    const duped = openSync(`/dev/fd/${socket._handle.fd}`, "r");
    const result = spawnSync(path.join(root, "host", "peerpath"), [], { stdio: ["ignore", "pipe", "pipe", duped] });
    closeSync(duped);
    assert.equal(result.status, 0);
    assert.equal(realpathSync(String(result.stdout).trim()), realpathSync(process.execPath));
    socket.write("still-open");
    const got = await new Promise((resolve) => client.once("data", resolve));
    assert.equal(got.toString(), "still-open");
    assert.equal(socket.destroyed, false);
  } finally {
    client.destroy();
    socket.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function expectNoForward(fromHost) {
  return Promise.race([
    fromHost.next().then((message) => {
      throw new Error(`forwarded ${message.method || "frame"}`);
    }),
    new Promise((resolve) => setTimeout(resolve, 250)),
  ]);
}

function waitClosed(socket) {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("expected the rejected peer socket to actually close")), 500);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function collect(stream) {
  const queued = [];
  let waiting = null;
  const parser = createFrameParser((message) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(message);
      return;
    }
    queued.push(message);
  });
  stream.on("data", (chunk) => parser.push(chunk));
  return {
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
  };
}

function waitForConnect(home) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (Date.now() - started > 3000) return reject(new Error("native host did not start"));
      const sock = socketPaths(home)[0];
      if (!sock) return setTimeout(tryOnce, 50);
      const socket = net.connect(sock);
      socket.once("connect", () => resolve(socket));
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started > 3000) {
          reject(new Error(`socket did not open: ${sock}`));
          return;
        }
        setTimeout(tryOnce, 50);
      });
    };
    tryOnce();
  });
}

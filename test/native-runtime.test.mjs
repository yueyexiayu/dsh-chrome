import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nativeFixtureEnv, requireInstalledRuntime } from "./fixtures/native-runtime.mjs";
import { socketPaths } from "../lib/install.js";

const fixtureUrl = new URL("./fixtures/native-runtime.mjs", import.meta.url).href;
const hostPath = new URL("../host/bridge.mjs", import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function privateHome(t, prefix = "dsh-chrome-runtime-") {
  const home = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => {
    assert.equal(path.dirname(realpathSync(home)), realpathSync(tmpdir()));
    assert.ok(path.basename(home).startsWith(prefix));
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill();
  await exited;
}

test("native fixture accepts the actual installed Electron executable without a fixed App name", () => {
  assert.equal(requireInstalledRuntime(), realpathSync(process.execPath));
});

test("native fixture refuses ordinary Node even with the installed App as argv0", t => {
  const result = spawnSync("/usr/local/bin/node", ["--input-type=module", "-e", `
    import { requireInstalledRuntime } from ${JSON.stringify(fixtureUrl)};
    requireInstalledRuntime();
  `], {
    argv0: process.execPath,
    env: nativeFixtureEnv(privateHome(t)),
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /genuine installed Electron runtime/);
});

test("native fixture requires Electron Node mode even after that mode started", () => {
  requireInstalledRuntime();
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    assert.throws(() => requireInstalledRuntime(), /ELECTRON_RUN_AS_NODE=1/);
  } finally {
    process.env.ELECTRON_RUN_AS_NODE = previous;
  }
});

test("native fixture env forces a canonical private mkdtemp home over inherited settings", t => {
  const home = privateHome(t);
  const previousHome = process.env.DSH_HOME;
  const previousBypass = process.env.DSH_CHROME_ALLOW_NODE_PEER;
  try {
    process.env.DSH_HOME = "/inherited-home-must-not-be-used";
    process.env.DSH_CHROME_ALLOW_NODE_PEER = "1";
    const env = nativeFixtureEnv(home);
    assert.equal(env.DSH_HOME, realpathSync(home));
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(Object.hasOwn(env, "DSH_CHROME_ALLOW_NODE_PEER"), false);
    assert.equal(process.env.DSH_HOME, "/inherited-home-must-not-be-used");
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousBypass === undefined) delete process.env.DSH_CHROME_ALLOW_NODE_PEER;
    else process.env.DSH_CHROME_ALLOW_NODE_PEER = previousBypass;
  }
});

test("native fixture rejects shared, nested and unrelated temporary homes", t => {
  const home = privateHome(t);
  chmodSync(home, 0o755);
  assert.throws(() => nativeFixtureEnv(home), /private|permission/);
  chmodSync(home, 0o700);
  const nested = path.join(home, "chrome-nested-ABC123");
  mkdirSync(nested, { mode: 0o700 });
  assert.throws(() => nativeFixtureEnv(nested), /directly under a system temporary directory/);
  const unrelated = privateHome(t, "not-a-native-fixture-");
  assert.throws(() => nativeFixtureEnv(unrelated));
});

test("OS peer identity rejects ordinary Node with forged DSH argv0 before forwarding", { timeout: 10000 }, async t => {
  requireInstalledRuntime();
  let host;
  t.after(async () => { if (host) await stop(host); });
  const home = privateHome(t);
  const env = nativeFixtureEnv(home);
  host = spawn(process.execPath, [hostPath.pathname], { env, stdio: ["pipe", "pipe", "pipe"] });
  let nativeOutput = "", errors = "";
  host.stdout.on("data", data => { nativeOutput += data.toString("hex"); });
  host.stderr.on("data", data => { errors += data; });
  const deadline = Date.now() + 3000;
  let endpoint;
  while (!(endpoint = socketPaths(home)[0]) && Date.now() < deadline) {
    assert.equal(host.exitCode, null, errors);
    await delay(10);
  }
  assert.ok(endpoint, `isolated native endpoint did not start: ${errors}`);
  const result = spawnSync("/usr/local/bin/node", ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import net from "node:net";
    import { encodeFrame } from ${JSON.stringify(new URL("../lib/frame.js", import.meta.url).href)};
    assert.equal(process.argv0, ${JSON.stringify(process.execPath)});
    assert.notEqual(process.execPath, process.argv0);
    const until = Date.now() + 2000;
    let socket;
    while (true) {
      socket = net.connect(process.argv[1]);
      try {
        await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
        break;
      } catch (error) {
        socket.destroy();
        if (!["ENOENT", "ECONNREFUSED"].includes(error.code) || Date.now() >= until) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    let received = false;
    const timer = setTimeout(() => { process.exitCode = 1; socket.destroy(); }, 1500);
    socket.on("data", () => { received = true; });
    socket.on("error", () => {});
    socket.once("close", () => {
      clearTimeout(timer);
      if (received) process.exitCode = 2;
      else if (!process.exitCode) process.stdout.write("FORGED_ARGV0_NODE_REJECTED\\n");
    });
    socket.write(encodeFrame({ method: "DSH.auth", token: "ab".repeat(32) }));
    socket.write(encodeFrame({ id: 1, method: "DSH.hello" }));
  `, endpoint], { argv0: process.execPath, env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "FORGED_ARGV0_NODE_REJECTED\n");
  await delay(40);
  assert.equal(host.exitCode, null, errors);
  assert.equal(host.signalCode, null, errors);
  assert.equal(nativeOutput, "", "denied OS peer must not forward an auth or hello frame");
});

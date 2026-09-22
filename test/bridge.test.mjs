import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFrameParser, encodeFrame } from "../lib/frame.js";
import { EXTENSION_ID, HOST_NAME, nativeHostManifest, pluginRoot } from "../lib/install.js";
import { GROUP_TITLE, groupTitle, ignoreFocusMethod, tabCreateProperties, windowCreateProperties } from "../extension/policy.js";
import { contextKey } from "../lib/owner.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  assert.equal(windowCreateProperties("about:blank").focused, false);
  assert.equal(GROUP_TITLE, "DSH");
  assert.equal(HOST_NAME, "com.yueyexiayu.dsh.chrome");
});

test("native host manifest is bound to this extension", () => {
  const manifest = nativeHostManifest();
  assert.equal(manifest.name, HOST_NAME);
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(manifest.path, path.join(pluginRoot(), "host", "dsh-chrome-host"));
});

test("conversations get separate tab groups", () => {
  assert.equal(groupTitle("session-aaaaaa"), "DSH aaaaaa");
  assert.notEqual(groupTitle("session-aaaaaa"), groupTitle("session-bbbbbb"));
  assert.equal(groupTitle("session-aaaaaa"), groupTitle("session-aaaaaa"));
  assert.equal(contextKey({ agent: { session: { id: "sess-123456" } } }), "sess-123456");
  assert.equal(contextKey({}), "default");
  assert.equal(GROUP_TITLE, "DSH");
});

test("extension source does not activate a tab or window", () => {
  const source = readFileSync(path.join(root, "extension", "background.js"), "utf8");
  assert.match(source, /tabCreateProperties\(/);
  assert.match(source, /windowCreateProperties\(/);
  assert.match(source, /ignoreFocusMethod\(/);
  assert.match(source, /groupTitle\(owner\)/);
  assert.doesNotMatch(source, /active:\s*true/);
  assert.doesNotMatch(source, /focused:\s*true/);
  assert.doesNotMatch(source, /bringToFront/);
});

test("host relays socket commands to the extension and replies back", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "dsh-chrome-"));
  const child = spawn(path.join(root, "host", "dsh-chrome-host"), {
    cwd: root,
    env: { ...process.env, DSH_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const sock = path.join(home, "cache", "dsh-chrome.sock");
  const socket = await waitForConnect(sock);
  try {
    const fromHost = collect(child.stdout);
    socket.write(encodeFrame({ id: 7, method: "DSH.hello" }));
    const outbound = await fromHost.next();
    assert.deepEqual(outbound, { id: 7, method: "DSH.hello" });
    const fromSocket = collect(socket);
    child.stdin.write(encodeFrame({ id: 7, result: { ok: true, group: "DSH" } }));
    assert.deepEqual(await fromSocket.next(), { id: 7, result: { ok: true, group: "DSH" } });
  } finally {
    socket.destroy();
    child.kill();
  }
});

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

function waitForConnect(sock) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
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

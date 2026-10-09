import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createFrameParser, encodeFrame } from "../lib/frame.js";
import { saveMark } from "../lib/marks.js";
import { socketPaths } from "../lib/install.js";

const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const epoch = randomBytes(16).toString("hex");
// A unique endpoint avoids deleting a live socket, including during concurrent
// startup or recovery after SIGKILL. Dead endpoints are ignored, never adopted.
const sock = path.join(home, "cache", `dsh-c-${epoch.slice(0, 8)}`);
fs.mkdirSync(path.dirname(sock), { recursive: true, mode: 0o700 });
let ownedSocket = null;
let ready = false;
let client = null;
let nextRequest = 0;
const pending = new Map();
// Set by the first path-checked DSH.auth. Kept only in this process.
// A later connection must present the same token and still pass the path check.
let sessionToken = null;
const TOKEN_RE = /^[0-9a-f]{64}$/i;
const ALLOW_NODE = process.env.DSH_CHROME_ALLOW_NODE_PEER === "1";

function sameToken(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function peerHelper() {
  return path.join(path.dirname(process.argv?.[1] || ""), "peerpath");
}

// Dup the accepted socket before the helper runs. The child must not close the
// fd this process is still reading. spawnSync also dups stdio, and we close
// only the extra parent dup.
function peerExecutable(socket) {
  const fd = socket?._handle?.fd;
  if (typeof fd !== "number" || fd < 0) return "";
  let duped = null;
  try {
    if (typeof fs.openSync === "function") {
      try { duped = fs.openSync(`/dev/fd/${fd}`, "r"); } catch { duped = null; }
    }
    const passed = duped ?? fd;
    const result = spawnSync(peerHelper(), [], {
      stdio: ["ignore", "pipe", "pipe", passed],
      timeout: 1000,
    });
    if (!result || result.status !== 0) return "";
    return String(result.stdout || "").replace(/\0/g, "").trim();
  } catch {
    return "";
  } finally {
    if (duped != null && typeof fs.closeSync === "function") {
      try { fs.closeSync(duped); } catch { /* the original socket stays open */ }
    }
  }
}

function peerAllowed(exe) {
  if (!exe || exe.includes("\0")) return false;
  if (exe.includes("/DeepSeek Harness.app/")) return true;
  // Test hosts set this when they spawn. Chrome's native-host launch does not.
  if (ALLOW_NODE && path.basename(exe) === "node") return true;
  return false;
}

function forget(socket) {
  for (const [id, request] of pending) {
    if (request.socket === socket) {
      clearTimeout(request.timer);
      pending.delete(id);
    }
  }
}

function writeNative(message) {
  process.stdout.write(encodeFrame(message));
}

const fromExtension = createFrameParser((message) => {
  if (message && message.method === "DSH.mark") {
    if (message.id == null) {
      process.stderr.write("dsh-chrome-host: mark request id is required\n");
      return;
    }
    try {
      const mark = saveMark(home, message.params || {});
      writeNative({ id: message.id, result: { ok: true, markId: mark.id } });
    } catch (error) {
      writeNative({ id: message.id, error: { message: error instanceof Error ? error.message : String(error),
        ...(error?.code === "MARK_NOT_SAVED" ? { code: "MARK_NOT_SAVED" } : {}) } });
    }
    return;
  }
  if (message?.id != null) {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (request.socket !== client || request.socket.destroyed) return;
    request.socket.write(encodeFrame({ ...message, id: request.id }));
    return;
  }
  if (!client || client.destroyed) return;
  client.write(encodeFrame(message));
});

process.stdin.on("data", (chunk) => {
  try {
    fromExtension.push(chunk);
  } catch (error) {
    process.stderr.write(`dsh-chrome-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
});
process.stdin.on("end", () => process.exit(0));

const server = net.createServer((socket) => {
  // Path check happens before any frame is parsed. A denied peer is destroyed
  // without a parser, so DSH.hello cannot be forwarded.
  const exe = peerExecutable(socket);
  if (!peerAllowed(exe)) {
    socket.destroy();
    return;
  }
  let authed = false;
  // Discovery probes do not claim the single controller slot. Only a valid
  // request can claim it, and another controller receives an explicit error.
  const admission = setTimeout(() => socket.destroy(), 5000);
  const fromPlugin = createFrameParser((message) => {
    if (!authed) {
      const token = typeof message?.token === "string" ? message.token : "";
      if (message?.method !== "DSH.auth" || !TOKEN_RE.test(token) || (sessionToken && !sameToken(token, sessionToken))) {
        socket.destroy();
        return;
      }
      if (!sessionToken) sessionToken = token.toLowerCase();
      authed = true;
      return;
    }
    if (message?.method === "DSH.auth") {
      socket.destroy();
      return;
    }
    if (message?.id == null || typeof message.method !== "string") {
      socket.destroy(new Error("browser request must have an id and method"));
      return;
    }
    if (!ready || (client && client !== socket && !client.destroyed)) {
      socket.end(encodeFrame({ id: message.id, error: {
        code: ready ? "BRIDGE_BUSY" : "BRIDGE_STARTING",
        message: ready
          ? "This Chrome profile is already controlled by another DSH process. Close that connection before retrying."
          : "DSH Chrome bridge is checking for other profiles. Retry after startup.",
      } }));
      return;
    }
    clearTimeout(admission);
    client = socket;
    const id = `${epoch}:${++nextRequest}`;
    const timer = setTimeout(() => pending.delete(id), 60_000);
    try {
      pending.set(id, { socket, id: message.id, timer });
      writeNative({ ...message, id });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on("data", (chunk) => {
    try {
      fromPlugin.push(chunk);
    } catch {
      socket.destroy();
    }
  });
  socket.on("close", () => {
    clearTimeout(admission);
    forget(socket);
    if (client === socket) client = null;
  });
  socket.on("error", () => {});
});

function activeEndpoint(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint);
    let settled = false;
    const finish = (error, active) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(active);
    };
    const timer = setTimeout(() => finish(new Error("Cannot determine whether another Chrome bridge is active")), 1000);
    socket.once("connect", () => finish(null, true));
    socket.on("error", error => {
      if (["ECONNREFUSED", "ENOENT"].includes(error.code)) finish(null, false);
      else finish(error);
    });
    socket.once("close", () => finish(null, false));
  });
}

function startupFailed(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dsh-chrome-host: ${message}\n`);
  process.stdout.write(encodeFrame({ method: "DSH.bridgeConflict", params: { message } }), () => process.exit(1));
}

server.on("error", startupFailed);
server.listen(sock, async () => {
  try {
    ownedSocket = fs.lstatSync(sock);
    fs.chmodSync(sock, 0o600);
    const others = socketPaths(home).filter(endpoint => endpoint !== sock);
    if (others.some(endpoint => path.basename(endpoint) === "dsh-chrome.sock")) {
      throw new Error("A legacy DSH Chrome socket is present. Quit the old DSH/Chrome host, remove its stale cache/dsh-chrome.sock, then reload the extension in the intended Chrome profile.");
    }
    const active = (await Promise.all(others.map(async endpoint => (await activeEndpoint(endpoint)) ? endpoint : null))).filter(Boolean);
    if (active.length) {
      throw new Error("Another Chrome profile already has an active DSH bridge. Disable the extension in other profiles, then reload it in the profile you want to control.");
    }
    ready = true;
  } catch (error) {
    startupFailed(error);
  }
});

// Only remove the exact endpoint this process created. Never unlink a shared
// pathname or an endpoint inherited from a previous/crashed native host.
process.on("exit", () => {
  if (!ownedSocket) return;
  try {
    const current = fs.lstatSync(sock);
    if (current.dev === ownedSocket.dev && current.ino === ownedSocket.ino && current.isSocket()) fs.unlinkSync(sock);
  } catch (error) {
    if (error.code !== "ENOENT") process.stderr.write(`dsh-chrome-host: endpoint cleanup failed: ${error.message}\n`);
  }
});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

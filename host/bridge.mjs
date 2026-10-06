import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createFrameParser, encodeFrame } from "../lib/frame.js";
import { saveMark } from "../lib/marks.js";

const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const sock = path.join(home, "cache", "dsh-chrome.sock");
fs.mkdirSync(path.dirname(sock), { recursive: true });
try {
  fs.unlinkSync(sock);
} catch {
  // no stale socket
}

let client = null;
const epoch = randomBytes(16).toString("hex");
let nextRequest = 0;
const pending = new Map();

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
      writeNative({ id: message.id, error: { message: error instanceof Error ? error.message : String(error) } });
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
  if (client) {
    forget(client);
    client.destroy();
  }
  client = socket;
  const fromPlugin = createFrameParser((message) => {
    if (message?.id == null || typeof message.method !== "string") {
      socket.destroy(new Error("browser request must have an id and method"));
      return;
    }
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
    forget(socket);
    if (client === socket) client = null;
  });
  socket.on("error", () => {});
});

server.listen(sock, () => {
  try {
    fs.chmodSync(sock, 0o600);
  } catch {
    // the directory is already user-owned
  }
});
server.on("error", (error) => {
  process.stderr.write(`dsh-chrome-host: ${error.message}\n`);
  process.exit(1);
});

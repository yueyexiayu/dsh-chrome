import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createFrameParser, encodeFrame } from "../lib/frame.js";

const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const sock = path.join(home, "cache", "dsh-chrome.sock");
fs.mkdirSync(path.dirname(sock), { recursive: true });
try {
  fs.unlinkSync(sock);
} catch {
  // no stale socket
}

let client = null;

function writeNative(message) {
  process.stdout.write(encodeFrame(message));
}

const fromExtension = createFrameParser((message) => {
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
  if (client) client.destroy();
  client = socket;
  const fromPlugin = createFrameParser((message) => {
    try {
      writeNative(message);
    } catch (error) {
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

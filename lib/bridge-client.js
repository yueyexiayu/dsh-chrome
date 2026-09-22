import net from "node:net";
import { createFrameParser, encodeFrame } from "./frame.js";
import { installMessage, installNativeHost, socketPath } from "./install.js";

const CONNECT_MS = 2500;

class BridgeLink {
  constructor(socket) {
    this.socket = socket;
    this.readyState = 1;
    this.handlers = { message: new Set(), close: new Set(), error: new Set() };
    const parser = createFrameParser((message) => {
      const event = { data: JSON.stringify(message) };
      for (const fn of this.handlers.message) fn(event);
    });
    socket.on("data", (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        this.fail(error);
      }
    });
    socket.on("close", () => {
      this.readyState = 3;
      for (const fn of this.handlers.close) fn();
    });
    socket.on("error", (error) => this.fail(error));
  }

  addEventListener(type, fn) {
    this.handlers[type]?.add(fn);
  }

  send(text) {
    this.socket.write(encodeFrame(JSON.parse(text)));
  }

  close() {
    this.socket.destroy();
  }

  fail(error) {
    this.readyState = 3;
    for (const fn of this.handlers.error) fn(error);
    this.socket.destroy();
  }
}

function waitForSocket(signal) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, socket) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(socket);
    };
    const tryOnce = () => {
      if (settled) return;
      if (signal?.aborted) {
        finish(new Error("cancelled"));
        return;
      }
      const socket = net.connect(socketPath());
      const fail = () => {
        socket.destroy();
        if (settled) return;
        if (Date.now() - started >= CONNECT_MS) {
          finish(new Error(installMessage()));
          return;
        }
        setTimeout(tryOnce, 200);
      };
      socket.once("connect", () => {
        socket.off("error", fail);
        finish(null, socket);
      });
      socket.once("error", fail);
    };
    tryOnce();
  });
}

function hello(socket, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const parser = createFrameParser((message) => {
      if (message.id !== 1) return;
      if (message.error) {
        finish(new Error(message.error.message || installMessage()));
        return;
      }
      if (!message.result?.ok) {
        finish(new Error(installMessage()));
        return;
      }
      finish(null);
    });
    const onData = (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        finish(error);
      }
    };
    const onAbort = () => finish(new Error("cancelled"));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      resolve(socket);
    };
    const timer = setTimeout(() => finish(new Error(installMessage())), CONNECT_MS);
    socket.on("data", onData);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.write(encodeFrame({ id: 1, method: "DSH.hello" }));
  });
}

export async function connectBridge(signal) {
  await installNativeHost();
  const socket = await waitForSocket(signal);
  await hello(socket, signal);
  return new BridgeLink(socket);
}

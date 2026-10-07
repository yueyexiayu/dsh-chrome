import net from "node:net";
import { createFrameParser, encodeFrame } from "./frame.js";
import { installMessage, installNativeHost, socketPaths } from "./install.js";

const CONNECT_MS = 2500;

class BridgeLink {
  constructor(socket) {
    this.socket = socket;
    this.readyState = 1;
    this.lastError = null;
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

  removeEventListener(type, fn) {
    this.handlers[type]?.delete(fn);
  }

  send(text) {
    if (this.readyState !== 1 || this.socket.destroyed) throw this.lastError || new Error("Chrome connection closed");
    this.socket.write(encodeFrame(JSON.parse(text)));
  }

  close() {
    this.readyState = 3;
    this.socket.destroy();
  }

  fail(error) {
    this.lastError = error;
    this.readyState = 3;
    this.socket.destroy();
    for (const fn of this.handlers.error) fn(error);
  }
}

function waitForSocket(signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let retry;
    const sockets = new Set();
    const onAbort = () => finish(new Error("cancelled"));
    const finish = (error, link) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(retry);
      signal?.removeEventListener("abort", onAbort);
      for (const socket of sockets) if (socket !== link?.socket) socket.destroy();
      if (error) reject(error);
      else resolve(link);
    };
    const deadline = setTimeout(() => finish(new Error(installMessage())), CONNECT_MS);
    const probe = (endpoint) => new Promise((resolveProbe, rejectProbe) => {
      const socket = net.connect(endpoint);
      sockets.add(socket);
      let done = false;
      const fail = (error) => {
        if (done) return;
        done = true;
        socket.destroy();
        sockets.delete(socket);
        if (error && !["ENOENT", "ECONNREFUSED"].includes(error.code)) rejectProbe(error);
        else resolveProbe(null);
      };
      socket.on("error", fail);
      socket.once("close", () => fail());
      socket.once("connect", () => {
        if (done || settled) return socket.destroy();
        done = true;
        // Permanent handlers exist before the connect-phase handler is removed;
        // the same parser/error handler owns discovery, hello and normal traffic.
        const link = new BridgeLink(socket);
        socket.off("error", fail);
        resolveProbe({ endpoint, link });
      });
    });
    const tryOnce = async () => {
      if (settled) return;
      if (signal?.aborted) return onAbort();
      try {
        const endpoints = socketPaths();
        // Connecting to an old host would evict its current client. Refuse the
        // legacy pathname without probing it or mutating it.
        if (endpoints.some(endpoint => /[/\\]dsh-chrome\.sock$/.test(endpoint))) {
          throw new Error("A legacy DSH Chrome socket is present. Quit the old DSH/Chrome host, remove its stale cache/dsh-chrome.sock, then reload the extension in the intended Chrome profile.");
        }
        const connected = (await Promise.all(endpoints.map(probe))).filter(Boolean);
        if (settled) return;
        const live = connected.filter(({ link }) => link.readyState === 1 && !link.socket.destroyed);
        if (live.length > 1) {
          finish(new Error("Multiple Chrome profiles are connected to DSH. Disable the extension in other profiles, then reload it in the profile you want to control."));
        } else if (live.length === 1) {
          finish(null, live[0].link);
        } else retry = setTimeout(tryOnce, 200);
      } catch (error) {
        finish(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void tryOnce();
  });
}

function hello(link, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message?.id !== 1) return;
      if (message.error) {
        finish(new Error(message.error.message || installMessage()));
        return;
      }
      if (!message.result?.ok) {
        finish(new Error(installMessage()));
        return;
      }
      if (message.result.protocolVersion !== 2) {
        finish(new Error(`DSH Chrome extension needs to be reloaded for bridge protocol 2.\n${installMessage()}`));
        return;
      }
      finish(null);
    };
    const onAbort = () => finish(new Error("cancelled"));
    const onError = (error) => finish(error);
    const onClose = () => finish(link.lastError || new Error("Chrome connection closed during handshake"));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      link.removeEventListener("message", onMessage);
      link.removeEventListener("error", onError);
      link.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        link.close();
        reject(error);
      } else resolve(link);
    };
    const timer = setTimeout(() => finish(new Error(installMessage())), CONNECT_MS);
    link.addEventListener("message", onMessage);
    link.addEventListener("error", onError);
    link.addEventListener("close", onClose);
    if (signal?.aborted) return onAbort();
    if (link.readyState !== 1 || link.socket.destroyed) return onClose();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      link.send(JSON.stringify({ id: 1, method: "DSH.hello" }));
    } catch (error) {
      finish(error);
    }
  });
}

export async function connectBridge(signal) {
  await installNativeHost();
  const link = await waitForSocket(signal);
  await hello(link, signal);
  if (link.readyState !== 1 || link.socket.destroyed) throw link.lastError || new Error("Chrome connection closed");
  return link;
}

import os from "node:os";
import path from "node:path";
import { installNativeHost } from "./install.js";
import { peekMark, ackMark, releaseMark } from "./marks.js";
import { chromeTools } from "./tools.js";

export const name = "chrome";
export const inject = ["tools", "connection"];

export const API_PATH = "/api/chrome/mark";

function home() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function apply(ctx) {
  installNativeHost().catch((error) => ctx.logger.warn("Chrome native host installation failed: %s", error.message));
  const attachments = { current: undefined };
  const llm = { current: undefined };
  ctx.inject(["attachments"], (scoped) => {
    attachments.current = scoped.get("attachments");
    return () => {
      attachments.current = undefined;
    };
  });
  ctx.inject(["llm"], (scoped) => {
    llm.current = scoped.get("llm");
    return () => {
      llm.current = undefined;
    };
  });
  ctx.effect(() => {
    const dispose = chromeTools({
      attachments: () => attachments.current,
      llm: () => llm.current,
    }).map((definition) => ctx.tools.register(definition));
    return () => {
      for (const stop of dispose) stop();
    };
  });
  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET", "POST"],
    requestBody: "buffered",
    async fetch(request) {
      try {
        if (request.method === "POST") {
          const body = await request.json();
          if (body.action === "ack") ackMark(home(), body.id, body.consumer, body.claim);
          else if (body.action === "release") releaseMark(home(), body.id, body.consumer, body.claim);
          else throw new Error("Unknown mark confirmation action");
          return jsonResponse(200, { ok: true, acknowledged: true });
        }
        return jsonResponse(200, { ok: true, mark: peekMark(home(), request.headers.get("x-dsh-chrome-consumer")) });
      } catch (error) {
        return jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : "标注读取失败" });
      }
    },
  });
}

import os from "node:os";
import path from "node:path";
import { installNativeHost } from "./install.js";
import { takeMark } from "./marks.js";
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
  installNativeHost().catch(() => {});
  ctx.effect(() => {
    const dispose = chromeTools().map((definition) => ctx.tools.register(definition));
    return () => {
      for (const stop of dispose) stop();
    };
  });
  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ["GET"],
    requestBody: "buffered",
    fetch() {
      try {
        return jsonResponse(200, { ok: true, mark: takeMark(home()) });
      } catch (error) {
        return jsonResponse(500, { ok: false, error: error instanceof Error ? error.message : "标注读取失败" });
      }
    },
  });
}

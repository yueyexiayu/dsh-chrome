import { installNativeHost } from "./install.js";
import { chromeTools } from "./tools.js";

export const name = "chrome";
export const inject = ["tools"];

export function apply(ctx) {
  installNativeHost().catch(() => {});
  ctx.effect(() => {
    const dispose = chromeTools().map((definition) => ctx.tools.register(definition));
    return () => {
      for (const stop of dispose) stop();
    };
  });
}

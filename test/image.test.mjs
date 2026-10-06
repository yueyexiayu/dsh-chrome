import assert from "node:assert/strict";
import test from "node:test";
import {
  projectScreenshot,
  renderScreenshot,
  routeAcceptsImages,
} from "../lib/image.js";
import { chromeTools } from "../lib/tools.js";

const REF = {
  attachmentId: "sha256:ab",
  mediaType: "image/png",
  bytes: 4,
  width: 1,
  height: 1,
  name: "shot.png",
};

test("screenshot render never emits a raw data image", () => {
  const raw = renderScreenshot(undefined, { text: "saved /tmp/a.png", image: Buffer.from("png").toString("base64") });
  assert.deepEqual(raw, [{ type: "text", text: "saved /tmp/a.png" }]);
  assert.equal(JSON.stringify(raw).includes("mimeType"), false);

  const attached = renderScreenshot(undefined, { text: "saved /tmp/a.png", image: REF });
  assert.equal(attached[1].type, "image");
  assert.equal(attached[1].attachment.attachmentId, REF.attachmentId);
  assert.equal(attached[1].data, undefined);
});

test("projectScreenshot stores an attachment and drops the base64", async () => {
  const raw = Buffer.from("png-bytes").toString("base64");
  let saved;
  const projected = await projectScreenshot(
    { text: "saved /tmp/chrome.png\nbytes: 9", image: raw },
    {
      saveImage: async (input) => {
        saved = input;
        return REF;
      },
    },
  );
  assert.equal(saved.mediaType, "image/png");
  assert.equal(saved.name, "chrome.png");
  assert.equal(Buffer.from(saved.data).toString(), "png-bytes");
  assert.equal(projected.image.attachmentId, REF.attachmentId);
  assert.equal(projected.image.data, undefined);
  assert.equal(JSON.stringify(projected).includes(raw), false);
});

test("projectScreenshot stays text-only when storage is missing or rejects", async () => {
  const raw = Buffer.from("png-bytes").toString("base64");
  const missing = await projectScreenshot({ text: "saved /tmp/a.png", image: raw });
  assert.equal(missing.image, undefined);
  assert.match(missing.text, /no attachment store/);
  assert.equal(JSON.stringify(renderScreenshot(undefined, missing)).includes("\"type\":\"image\""), false);

  const rejected = await projectScreenshot(
    { text: "saved /tmp/a.png", image: raw },
    { saveImage: async () => { throw new Error("too large"); } },
  );
  assert.equal(rejected.image, undefined);
  assert.match(rejected.text, /too large/);
});


test("chrome screenshot tool no longer declares a raw image string", () => {
  const shot = chromeTools().find((definition) => definition.name === "chrome_screenshot");
  assert.equal(shot.output.schema.properties.image.type, "object");
  assert.equal(shot.output.schema.properties.image.properties.attachmentId.type, "string");
  const rendered = shot.output.render({}, { text: "saved", image: "aaaa" });
  assert.deepEqual(rendered, [{ type: "text", text: "saved" }]);
});

test("image admission requires positive current model support", async () => {
  const exec = { agent: { session: { requestHeader: () => ({ config: { provider: "xai", model: "grok" } }) } } };
  assert.equal(await routeAcceptsImages(null, exec), false);
  assert.equal(await routeAcceptsImages({ resolveModelInfo: async () => ({}) }, exec), false);
  assert.equal(await routeAcceptsImages({ resolveModelInfo: async () => ({ inputModalities: ["text"] }) }, exec), false);
  assert.equal(await routeAcceptsImages({ resolveModelInfo: async () => ({ inputModalities: ["text", "image"] }) }, exec), true);
  await assert.rejects(routeAcceptsImages({ resolveModelInfo: async () => { throw new Error("route failed"); } }, exec), /route failed/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(routeAcceptsImages(null, { ...exec, signal: controller.signal }), { name: "AbortError" });
});

test("unconfirmed image input remains text only and does not save an attachment", async () => {
  let saves = 0;
  const shot = await projectScreenshot({ text: "saved /tmp/a.png", image: "cG5n" }, {
    saveImage: async () => { saves += 1; return REF; },
    acceptsImages: async () => false,
  });
  assert.equal(saves, 0);
  assert.equal(shot.image, undefined);
  assert.match(shot.text, /could not be confirmed/);
});

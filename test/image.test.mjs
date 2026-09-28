import assert from "node:assert/strict";
import test from "node:test";
import {
  guardLlm,
  hasRawImage,
  projectScreenshot,
  renderScreenshot,
  sanitizeModelMessages,
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

test("sanitize rewrites poisoned tool results and leaves valid images", async () => {
  const raw = Buffer.from("png-bytes").toString("base64");
  const messages = [{
    role: "user",
    content: [{
      type: "tool-result",
      content: [
        { type: "text", text: "saved /tmp/a.png" },
        { type: "image", data: raw, mimeType: "image/png" },
        { type: "image", attachment: REF },
      ],
    }],
  }];
  assert.equal(hasRawImage(messages), true);
  const healed = await sanitizeModelMessages(messages, async () => REF);
  const nested = healed[0].content[0].content;
  assert.equal(nested[1].attachment.attachmentId, REF.attachmentId);
  assert.equal(nested[1].data, undefined);
  assert.equal(nested[2].attachment, REF);
  assert.equal(hasRawImage(healed), false);

  const dropped = await sanitizeModelMessages(messages);
  assert.equal(dropped[0].content[0].content[1].type, "text");
  assert.match(dropped[0].content[0].content[1].text, /attachment reference/);
});

test("llm guard rewrites only poisoned requests", async () => {
  const seen = [];
  const llm = {
    prepareCall() {
      return {
        config: { provider: "xai", model: "grok" },
        stream(request) {
          seen.push(request);
          return ["ok"];
        },
      };
    },
    stream(request) {
      seen.push(request);
      return ["direct"];
    },
  };
  assert.equal(guardLlm(llm, {
    attachments: () => ({ saveImage: async () => REF }),
  }), true);
  assert.equal(guardLlm(llm), false);

  const healthy = { provider: "xai", model: "grok", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const prepared = await llm.prepareCall();
  assert.deepEqual(prepared.stream(healthy), ["ok"]);
  assert.equal(seen[0], healthy);

  const raw = Buffer.from("png-bytes").toString("base64");
  const poisoned = {
    provider: "xai",
    model: "grok",
    messages: [{ role: "user", content: [{ type: "image", data: raw, mimeType: "image/png" }] }],
  };
  const chunks = [];
  for await (const chunk of prepared.stream(poisoned)) chunks.push(chunk);
  assert.deepEqual(chunks, ["ok"]);
  assert.equal(seen[1].messages[0].content[0].attachment.attachmentId, REF.attachmentId);
  assert.equal(seen[1].provider, "xai");
});

test("chrome screenshot tool no longer declares a raw image string", () => {
  const shot = chromeTools().find((definition) => definition.name === "chrome_screenshot");
  assert.equal(shot.output.schema.properties.image.type, "object");
  assert.equal(shot.output.schema.properties.image.properties.attachmentId.type, "string");
  const rendered = shot.output.render({}, { text: "saved", image: "aaaa" });
  assert.deepEqual(rendered, [{ type: "text", text: "saved" }]);
});

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function errorMessage(error) {
  return error instanceof Error ? error.message : "attachment store rejected the screenshot";
}

function appendNote(text, note) {
  return text.includes(note) ? text : `${text}${text ? "\n" : ""}${note}`;
}

function screenshotName(text) {
  const match = /^saved\s+(\S+)/m.exec(String(text || ""));
  const base = match ? match[1].split(/[\\/]/).pop() : "";
  return base || "chrome-screenshot.png";
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validAttachment(attachment) {
  return isRecord(attachment)
    && typeof attachment.attachmentId === "string"
    && attachment.attachmentId.length > 0
    && MEDIA_TYPES.has(attachment.mediaType)
    && Number.isInteger(attachment.bytes)
    && attachment.bytes >= 0
    && Number.isInteger(attachment.width)
    && attachment.width > 0
    && Number.isInteger(attachment.height)
    && attachment.height > 0;
}

export function attachmentFields(ref) {
  if (!validAttachment(ref)) return undefined;
  const image = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  };
  if (typeof ref.name === "string" && ref.name.length > 0) image.name = ref.name;
  const original = ref.originalDimensions;
  if (isRecord(original) && Number.isInteger(original.width) && Number.isInteger(original.height)) {
    image.originalDimensions = { width: original.width, height: original.height };
  }
  return image;
}

/** Model-facing blocks. A string or data/mimeType image is never emitted. */
export function renderScreenshot(_args, value) {
  const blocks = [{ type: "text", text: String(value && value.text || "") }];
  const image = attachmentFields(value && value.image);
  if (image) blocks.push({ type: "image", attachment: image });
  return blocks;
}

function decodePng(raw) {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const compact = raw.replace(/\s+/g, "");
  const data = Buffer.from(compact, "base64");
  if (data.length === 0 || data.toString("base64") !== compact) {
    throw new Error("screenshot bytes were not canonical base64");
  }
  return data;
}

/**
 * Turn a browser screenshot into a durable attachment reference.
 * Failure stays text-only so a later model request cannot crash on attachmentId.
 */
export async function projectScreenshot(shot, options = {}) {
  const text = String(shot && shot.text || "");
  const raw = shot && shot.image;
  if (typeof raw !== "string" || raw.length === 0) return { text };
  if (typeof options.saveImage !== "function") {
    return { text: appendNote(text, "Image was not attached because no attachment store is mounted. Use read_image on the saved path.") };
  }
  if (typeof options.acceptsImages === "function" && await options.acceptsImages() === false) {
    return { text: appendNote(text, "Image was not attached because image input support could not be confirmed for the current model. Use read_image after switching to an image-capable model.") };
  }
  let data;
  try {
    data = decodePng(raw);
  } catch (error) {
    return { text: appendNote(text, `Image was not attached: ${errorMessage(error)}. Use read_image on the saved path.`) };
  }
  try {
    const ref = await options.saveImage({ data, mediaType: "image/png", name: screenshotName(text) });
    const image = attachmentFields(ref);
    if (!image) {
      return { text: appendNote(text, "Image was not attached because the attachment store returned no attachmentId. Use read_image on the saved path.") };
    }
    return { text, image };
  } catch (error) {
    return { text: appendNote(text, `Image was not attached: ${errorMessage(error)}. Use read_image on the saved path.`) };
  }
}

export async function routeAcceptsImages(llm, exec) {
  exec?.signal?.throwIfAborted();
  if (!llm || typeof llm.resolveModelInfo !== "function" || !exec) return false;
  const routed = exec.agent && exec.agent.session && exec.agent.session.requestHeader
    ? exec.agent.session.requestHeader().config
    : undefined;
  const provider = (routed && routed.provider) || (exec.agent && exec.agent.options && exec.agent.options.provider);
  const model = (routed && routed.model) || (exec.agent && exec.agent.options && exec.agent.options.model);
  if (!provider || !model) return false;
  const info = await llm.resolveModelInfo(provider, model, exec.signal);
  exec.signal?.throwIfAborted();
  return Boolean(info && Array.isArray(info.inputModalities) && info.inputModalities.includes("image"));
}

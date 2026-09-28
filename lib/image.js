const GUARD = Symbol("chrome.image-guard");
const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const OMITTED = "[image omitted: this tool result stored raw image bytes without an attachment reference, so it cannot be sent to the model]";

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
    return { text: appendNote(text, "Image was not attached because the current model does not accept image input. Use read_image after switching to an image-capable model.") };
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
  if (!llm || typeof llm.resolveModelInfo !== "function" || !exec) return true;
  const routed = exec.agent && exec.agent.session && exec.agent.session.requestHeader
    ? exec.agent.session.requestHeader().config
    : undefined;
  const provider = (routed && routed.provider) || (exec.agent && exec.agent.options && exec.agent.options.provider);
  const model = (routed && routed.model) || (exec.agent && exec.agent.options && exec.agent.options.model);
  if (!provider || !model) return true;
  try {
    const info = await llm.resolveModelInfo(provider, model, exec.signal);
    return !(info && Array.isArray(info.inputModalities) && !info.inputModalities.includes("image"));
  } catch {
    return true;
  }
}

function rawImage(block) {
  return isRecord(block)
    && block.type === "image"
    && !validAttachment(block.attachment)
    && typeof block.data === "string"
    && MEDIA_TYPES.has(block.mimeType);
}

async function admitBlock(block, saveImage) {
  if (!rawImage(block) || typeof saveImage !== "function") {
    return { type: "text", text: OMITTED };
  }
  try {
    const ref = await saveImage({
      data: decodePng(block.data),
      mediaType: block.mimeType,
      name: typeof block.name === "string" && block.name ? block.name : "recovered-image.png",
    });
    const image = attachmentFields(ref);
    if (!image) return { type: "text", text: OMITTED };
    return { type: "image", attachment: image };
  } catch {
    return { type: "text", text: OMITTED };
  }
}

async function sanitizeBlocks(blocks, saveImage) {
  if (!Array.isArray(blocks)) return blocks;
  let changed = false;
  const next = [];
  for (const block of blocks) {
    if (!isRecord(block)) {
      next.push(block);
      continue;
    }
    let current = block;
    if (Array.isArray(block.content)) {
      const nested = await sanitizeBlocks(block.content, saveImage);
      if (nested !== block.content) {
        changed = true;
        current = { ...block, content: nested };
      }
    }
    if (current.type === "image" && !validAttachment(current.attachment)) {
      changed = true;
      next.push(await admitBlock(current, saveImage));
      continue;
    }
    next.push(current);
  }
  return changed ? next : blocks;
}

/** Copy only messages that contain an image block without attachmentId. */
export async function sanitizeModelMessages(messages, saveImage) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = [];
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      next.push(message);
      continue;
    }
    const content = await sanitizeBlocks(message.content, saveImage);
    if (content !== message.content) {
      changed = true;
      next.push({ ...message, content });
    } else {
      next.push(message);
    }
  }
  return changed ? next : messages;
}

function blockHasRawImage(block) {
  if (!isRecord(block)) return false;
  if (block.type === "image" && !validAttachment(block.attachment)) return true;
  return Array.isArray(block.content) && block.content.some(blockHasRawImage);
}

export function hasRawImage(messages) {
  return Array.isArray(messages) && messages.some((message) => (
    isRecord(message) && Array.isArray(message.content) && message.content.some(blockHasRawImage)
  ));
}

function withSanitizedMessages(options, saveImage) {
  if (!isRecord(options) || !Array.isArray(options.messages)) return Promise.resolve(options);
  return sanitizeModelMessages(options.messages, saveImage).then((messages) => (
    messages === options.messages ? options : { ...options, messages }
  ));
}

/**
 * Heal sessions already poisoned by raw screenshot blocks.
 * New screenshots are stored as attachments; this only rewrites the outgoing request.
 */
export function guardLlm(llm, options = {}) {
  if (!llm || llm[GUARD] === true) return false;
  const saveImage = () => {
    const store = typeof options.attachments === "function" ? options.attachments() : undefined;
    return store && typeof store.saveImage === "function" ? store.saveImage.bind(store) : undefined;
  };
  if (typeof llm.prepareCall === "function") {
    const originalPrepare = llm.prepareCall;
    llm.prepareCall = async function guardedPrepare(config, signal) {
      const prepared = await originalPrepare.call(llm, config, signal);
      if (!prepared || typeof prepared.stream !== "function") return prepared;
      const stream = prepared.stream.bind(prepared);
      return {
        ...prepared,
        stream(request) {
          if (!isRecord(request) || !hasRawImage(request.messages)) return stream(request);
          return {
            async *[Symbol.asyncIterator]() {
              yield* stream(await withSanitizedMessages(request, saveImage()));
            },
          };
        },
      };
    };
  }
  if (typeof llm.stream === "function") {
    const originalStream = llm.stream;
    llm.stream = function guardedStream(request, ...rest) {
      if (!isRecord(request) || !hasRawImage(request.messages)) return originalStream.call(llm, request, ...rest);
      return {
        async *[Symbol.asyncIterator]() {
          yield* originalStream.call(llm, await withSanitizedMessages(request, saveImage()), ...rest);
        },
      };
    };
  }
  try {
    Object.defineProperty(llm, GUARD, { value: true });
  } catch {
    llm[GUARD] = true;
  }
  return true;
}

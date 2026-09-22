/** Pure page helpers for the chrome plugin. No browser process. */

export const TEXT_LIMIT = 8000;
export const TEXT_READ_LIMIT = 24000;
export const ELEMENT_LIMIT = 60;
export const OFFSCREEN_LIMIT = 20;
export const QUERY_LIMIT = 40;
export const HTML_LIMIT = 20000;
export const MARKDOWN_BLOCKS = 120;
export const EVAL_INPUT_LIMIT = 8000;
export const EVAL_OUTPUT_LIMIT = 12000;
export const CONSOLE_LIMIT = 40;
export const NETWORK_LIMIT = 40;
export const BODY_LIMIT = 4000;
export const WAIT_DEFAULT_MS = 8000;
export const WAIT_MAX_MS = 20000;
export const A11Y_NODE_LIMIT = 80;
export const FIND_LIMIT = 20;

const INTERACTIVE = 'a[href], button, input, textarea, select, summary, [role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"]';

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

const SECRET_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|password|passwd|secret|cookie|session(?:id)?|(?:^|_)token(?:$|_))/i;

const MOD_BITS = {
  alt: 1,
  option: 1,
  control: 2,
  ctrl: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const REF_ENGINE = `
function dshAbsBox(el) {
  var box = el.getBoundingClientRect();
  var x = box.left;
  var y = box.top;
  var view = el.ownerDocument.defaultView;
  while (view && view.frameElement) {
    var frameBox = view.frameElement.getBoundingClientRect();
    x += frameBox.left;
    y += frameBox.top;
    view = view.frameElement.ownerDocument.defaultView;
  }
  return {
    left: Math.round(x),
    top: Math.round(y),
    width: Math.round(box.width),
    height: Math.round(box.height),
    x: Math.round(x + box.width / 2),
    y: Math.round(y + box.height / 2),
  };
}
function dshInView(box) {
  return box.width >= 2 && box.height >= 2 && box.top < window.innerHeight && (box.top + box.height) > 0 && box.left < window.innerWidth && (box.left + box.width) > 0;
}
function dshHidden(el) {
  var style = getComputedStyle(el);
  return style.visibility === "hidden" || style.display === "none";
}
function dshName(el) {
  return (el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.innerText || (typeof el.value === "string" ? el.value : "") || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim().slice(0, 120);
}
function dshRegister(el) {
  if (!window.__dshRefs) window.__dshRefs = [];
  var ref = window.__dshRefs.length;
  window.__dshRefs.push(el);
  try { el.setAttribute("data-dsh-ref", String(ref)); } catch (error) {}
  return ref;
}
function dshLookup(ref) {
  var el = window.__dshRefs && window.__dshRefs[ref];
  if (!el || !el.isConnected) return null;
  return el;
}
function dshWalk(root, visit, depth, state) {
  if (!root || depth > 8 || state.seen > 5000) return;
  var nodes = [];
  try { nodes = root.querySelectorAll ? root.querySelectorAll("*") : []; } catch (error) { nodes = []; }
  for (var i = 0; i < nodes.length; i += 1) {
    if (state.seen > 5000) return;
    state.seen += 1;
    var el = nodes[i];
    visit(el);
    if (el.shadowRoot) dshWalk(el.shadowRoot, visit, depth + 1, state);
    if (el.tagName === "IFRAME") {
      try { if (el.contentDocument) dshWalk(el.contentDocument, visit, depth + 1, state); } catch (error) {}
    }
  }
}
function dshDescribe(el, ref) {
  var box = dshAbsBox(el);
  var inputType = (el.getAttribute("type") || "").toLowerCase();
  return {
    ref: ref,
    tag: el.tagName.toLowerCase(),
    type: inputType,
    role: el.getAttribute("role") || "",
    name: dshName(el),
    href: el.href || el.getAttribute("href") || "",
    value: "value" in el ? String(el.value || "").slice(0, 80) : "",
    disabled: Boolean(el.disabled || el.getAttribute("aria-disabled") === "true"),
    checked: Boolean(el.checked || el.getAttribute("aria-checked") === "true"),
    expanded: el.getAttribute("aria-expanded") === "true",
    frame: el.ownerDocument === document ? "top" : "iframe",
    inView: dshInView(box) && !dshHidden(el),
    box: box,
  };
}
function dshFind(selector, limit) {
  try { document.querySelector(selector); }
  catch (error) { return { ok: false, error: "invalid selector" }; }
  var found = [];
  dshWalk(document, function (el) {
    if (found.length >= limit) return;
    try { if (el.matches && el.matches(selector)) found.push(el); } catch (error) {}
  }, 0, { seen: 0 });
  return { ok: true, found: found };
}
`;

function pageScript(body) {
  return `(() => {\n${REF_ENGINE}\n${body}\n})()`;
}

/**
 * Accept only http(s) navigation targets.
 * @param {unknown} raw
 * @returns {string}
 */
export function assertHttpUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("url must be an http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http and https URLs are allowed");
  }
  return url.href;
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function assertRef(raw) {
  const ref = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(ref) || ref < 0) throw new Error("ref must be a non-negative integer from the latest snapshot");
  return ref;
}

/**
 * @param {unknown} raw
 * @returns {{ key: string, code: string, windowsVirtualKeyCode: number, text?: string }}
 */
function resolveKey(name) {
  if (KEYS[name]) return { ...KEYS[name] };
  if (/^[a-zA-Z]$/.test(name)) {
    const upper = name.toUpperCase();
    return { key: name, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: name };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, windowsVirtualKeyCode: name.charCodeAt(0), text: name };
  }
  throw new Error(`key must be a letter, digit, or one of: ${Object.keys(KEYS).join(", ")}`);
}

/**
 * @param {unknown} raw
 * @returns {{ key: string, code: string, windowsVirtualKeyCode: number, text?: string, modifiers: number }}
 */
export function assertKey(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("key is required");
  const parts = text.split("+").map((part) => part.trim()).filter(Boolean);
  let modifiers = 0;
  const keys = [];
  for (const part of parts) {
    const bit = MOD_BITS[part.toLowerCase()];
    if (bit) modifiers |= bit;
    else keys.push(part);
  }
  if (keys.length !== 1) throw new Error("key must contain one key, with optional Control, Shift, Alt, or Meta");
  const key = resolveKey(keys[0]);
  if (modifiers) delete key.text;
  return { ...key, modifiers };
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
export function assertModifiers(raw) {
  if (raw == null || raw === "") return 0;
  const parts = String(raw).split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  let bits = 0;
  for (const part of parts) {
    if (!(part in MOD_BITS)) throw new Error("modifiers must be Control, Shift, Alt, or Meta");
    bits |= MOD_BITS[part];
  }
  return bits;
}

/**
 * @param {unknown} raw
 * @returns {"up" | "down" | "top" | "bottom"}
 */
export function assertDirection(raw) {
  const direction = String(raw ?? "").trim();
  if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right" && direction !== "top" && direction !== "bottom") {
    throw new Error("direction must be up, down, left, right, top, or bottom");
  }
  return direction;
}

/**
 * @param {unknown} raw
 * @returns {"left" | "right" | "middle"}
 */
export function assertButton(raw) {
  const button = raw == null || raw === "" ? "left" : String(raw).trim();
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new Error("button must be left, right, or middle");
  }
  return button;
}

/**
 * @param {unknown} raw
 * @returns {1 | 2}
 */
export function assertClickCount(raw) {
  if (raw == null || raw === "") return 1;
  const count = typeof raw === "number" ? raw : Number(raw);
  if (count !== 1 && count !== 2 && count !== 3) throw new Error("click_count must be 1, 2, or 3");
  return count;
}

/**
 * @param {unknown} raw
 * @returns {"back" | "forward" | "reload"}
 */
export function assertHistory(raw) {
  const action = String(raw ?? "").trim();
  if (action !== "back" && action !== "forward" && action !== "reload") {
    throw new Error("action must be back, forward, or reload");
  }
  return action;
}

/**
 * @param {unknown} x
 * @param {unknown} y
 * @returns {{ x: number, y: number }}
 */
export function assertPoint(x, y) {
  const px = typeof x === "number" ? x : Number(x);
  const py = typeof y === "number" ? y : Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error("x and y must be finite numbers");
  return { x: px, y: py };
}

/**
 * @param {unknown} raw
 * @returns {"accept" | "dismiss"}
 */
export function assertDialog(raw) {
  const action = String(raw ?? "").trim();
  if (action !== "accept" && action !== "dismiss") throw new Error("action must be accept or dismiss");
  return action;
}

/**
 * @param {unknown} raw
 * @returns {{ filter: "interactive" | "all", depth: number, ref: number | null }}
 */
export function assertA11y(raw) {
  const filter = raw?.filter == null || raw.filter === "" ? "interactive" : String(raw.filter).trim();
  if (filter !== "interactive" && filter !== "all") throw new Error("filter must be interactive or all");
  return {
    filter,
    depth: assertLimit(raw?.depth, 15, 20),
    ref: raw?.ref == null || raw.ref === "" ? null : assertRef(raw.ref),
  };
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function assertFind(raw) {
  const query = String(raw ?? "").trim();
  if (!query) throw new Error("query is required");
  if (query.length > 200) throw new Error("query is too long");
  return query;
}

/**
 * @param {unknown} raw
 * @returns {Array<{ ref: number, value: string }>}
 */
export function assertFill(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("fields is required");
  if (raw.length > 30) throw new Error("at most 30 fields");
  return raw.map((field, index) => {
    if (!field || typeof field !== "object") throw new Error(`fields[${index}] must be an object`);
    return { ref: assertRef(field.ref), value: field.value == null ? "" : String(field.value) };
  });
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function assertSelector(raw) {
  const selector = String(raw ?? "").trim();
  if (!selector) throw new Error("selector is required");
  if (selector.length > 300) throw new Error("selector is too long");
  return selector;
}

/**
 * @param {unknown} raw
 * @returns {"text" | "html" | "markdown"}
 */
export function assertFormat(raw) {
  const format = raw == null || raw === "" ? "text" : String(raw).trim();
  if (format !== "text" && format !== "html" && format !== "markdown") {
    throw new Error("format must be text, html, or markdown");
  }
  return format;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
export function assertLimit(raw, fallback, max) {
  if (raw == null || raw === "") return fallback;
  const limit = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > max) {
    throw new Error(`limit must be an integer from 1 to ${max}`);
  }
  return limit;
}

/**
 * @param {{ selector?: unknown, text?: unknown, url?: unknown, ms?: unknown, state?: unknown }} raw
 * @returns {{ selector: string, text: string, url: string, ms: number, state: "visible" | "hidden" }}
 */
export function assertWait(raw) {
  const selector = String(raw?.selector ?? "").trim();
  const text = String(raw?.text ?? "").trim();
  const url = String(raw?.url ?? "").trim();
  const state = raw?.state == null || raw.state === "" ? "visible" : String(raw.state).trim();
  if (state !== "visible" && state !== "hidden") throw new Error("state must be visible or hidden");
  if (selector.length > 300) throw new Error("selector is too long");
  const hasTarget = Boolean(selector || text || url);
  const ms = assertLimit(raw?.ms, hasTarget ? WAIT_DEFAULT_MS : 1000, WAIT_MAX_MS);
  return { selector, text, url, ms, state };
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
/**
 * Compare a frame URL with an iframe src, ignoring hash and rnd.
 * @param {unknown} url
 * @returns {string}
 */
export function frameMatchKey(url) {
  try {
    const parsed = new URL(String(url));
    parsed.hash = "";
    parsed.searchParams.delete("rnd");
    return parsed.href;
  } catch {
    return String(url || "");
  }
}

/**
 * @param {unknown} frameUrl
 * @param {Array<{ src?: string }> | undefined} boxes
 * @returns {{ src?: string, left?: number, top?: number, hidden?: boolean } | null}
 */
export function matchFrameBox(frameUrl, boxes) {
  const key = frameMatchKey(frameUrl);
  let best = null;
  let bestLength = -1;
  for (const box of boxes || []) {
    const other = frameMatchKey(box.src);
    if (!other) continue;
    if (key !== other && !key.startsWith(other) && !other.startsWith(key)) continue;
    if (other.length > bestLength) {
      best = box;
      bestLength = other.length;
    }
  }
  return best;
}

export function assertEval(raw) {
  const expression = String(raw ?? "");
  if (!expression.trim()) throw new Error("expression is required");
  if (expression.length > EVAL_INPUT_LIMIT) throw new Error(`expression must be at most ${EVAL_INPUT_LIMIT} characters`);
  return expression;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function assertPaths(raw) {
  const list = Array.isArray(raw) ? raw : [raw];
  const paths = list.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (paths.length === 0) throw new Error("paths is required");
  if (paths.length > 20) throw new Error("at most 20 files");
  return paths;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function redactUrl(raw) {
  const value = String(raw ?? "");
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEY.test(key)) url.searchParams.set(key, "••••");
    }
    return url.href.length > 300 ? `${url.href.slice(0, 300)}…` : url.href;
  } catch {
    return value
      .replace(/([?&][^=&\s]*(?:token|password|secret|api[_-]?key|cookie)[^=&\s]*=)[^&\s]*/gi, "$1••••")
      .slice(0, 300);
  }
}

/**
 * @param {unknown} raw
 * @param {number} [limit]
 * @returns {{ text: string, truncated: boolean, redacted: boolean }}
 */
export function redactText(raw, limit = BODY_LIMIT) {
  const source = String(raw ?? "");
  let redacted = false;
  const masked = source.replace(
    /("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+|true|false|null)/g,
    (all, key, sep, val) => {
      const name = key.slice(1, -1);
      if (!SECRET_KEY.test(name)) return all;
      redacted = true;
      return `${key}${sep}"••••"`;
    },
  );
  return {
    text: masked.slice(0, limit),
    truncated: masked.length > limit,
    redacted,
  };
}

/**
 * @param {Array<{ tag?: string, level?: number, text?: string, href?: string }>} blocks
 * @returns {string}
 */
export function toMarkdown(blocks) {
  const lines = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const text = String(block.text || "").trim();
    if (!text) continue;
    if (block.tag === "h") {
      const level = Math.min(6, Math.max(1, Number(block.level) || 1));
      lines.push(`${"#".repeat(level)} ${text}`, "");
    } else if (block.tag === "li") {
      lines.push(`- ${text}`);
    } else if (block.tag === "pre") {
      lines.push("```", text, "```", "");
    } else if (block.tag === "a" && block.href) {
      lines.push(`[${text}](${block.href})`, "");
    } else {
      lines.push(text, "");
    }
  }
  return lines.join("\n").trim();
}

/**
 * @param {Date} [now]
 * @returns {string}
 */
export function screenshotName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `chrome-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${now.getMilliseconds()}.png`;
}

function elementLine(el) {
  const bits = [`[${el.ref}] ${el.tag}`];
  if (el.type) bits.push(String(el.type));
  if (el.role) bits.push(`role=${el.role}`);
  if (el.name) bits.push(JSON.stringify(el.name));
  if (el.href) bits.push(`href=${el.href}`);
  if (el.value) bits.push(`value=${JSON.stringify(el.value)}`);
  if (el.disabled) bits.push("disabled");
  if (el.checked) bits.push("checked");
  if (el.expanded) bits.push("expanded");
  if (el.frame && el.frame !== "top") bits.push(String(el.frame));
  if (el.inView === false) bits.push("offscreen");
  return bits.join(" ");
}

/**
 * Model-facing text for one page observation.
 * @param {{ url?: string, title?: string, text?: string, truncatedText?: boolean, headings?: Array<Record<string, unknown>>, elements?: Array<Record<string, unknown>>, offscreen?: Array<Record<string, unknown>>, offscreenCount?: number, dialog?: string }} obs
 * @returns {string}
 */
export function formatObservation(obs) {
  const elements = Array.isArray(obs.elements) ? obs.elements : [];
  const lines = [
    `url: ${obs.url || ""}`,
    `title: ${obs.title || ""}`,
  ];
  if (obs.dialog) lines.push(`dialog: ${obs.dialog}`);
  const headings = Array.isArray(obs.headings) ? obs.headings : [];
  if (headings.length > 0) {
    lines.push("headings:");
    for (const heading of headings) lines.push(`- h${heading.level || 1} ${JSON.stringify(heading.name || "")}`);
  }
  lines.push("text:", obs.text || "(empty)");
  if (obs.truncatedText) lines.push("text truncated; use chrome_get_text or chrome_content for more");
  lines.push("elements:");
  if (elements.length === 0) lines.push("(none in view)");
  for (const el of elements) lines.push(elementLine(el));
  const offscreen = Array.isArray(obs.offscreen) ? obs.offscreen : [];
  if (offscreen.length > 0 || obs.offscreenCount) {
    lines.push(`offscreen: ${obs.offscreenCount || offscreen.length}`);
    for (const el of offscreen) lines.push(elementLine(el));
  }
  lines.push("hint: refs come from the latest chrome_snapshot, chrome_a11y, chrome_find, or chrome_query. Use chrome_a11y for the tree and chrome_find for text. If a dialog is open, call chrome_dialog before the next action.");
  return lines.join("\n");
}

/**
 * @param {{ url?: string, title?: string, selector?: string, ref?: number, text?: string, truncated?: boolean }} obs
 * @returns {string}
 */
export function formatText(obs) {
  const lines = [`url: ${obs.url || ""}`, `title: ${obs.title || ""}`];
  if (obs.selector) lines.push(`selector: ${obs.selector}`);
  if (obs.ref !== undefined && obs.ref !== null) lines.push(`ref: ${obs.ref}`);
  if (obs.truncated) lines.push("truncated: true");
  lines.push("text:", obs.text || "(empty)");
  return lines.join("\n");
}

/**
 * @param {{ url?: string, title?: string, format?: string, text?: string, html?: string, blocks?: Array<Record<string, unknown>>, links?: Array<Record<string, unknown>>, truncated?: boolean, selector?: string }} obs
 * @returns {string}
 */
export function formatContent(obs) {
  const format = obs.format || "text";
  const lines = [`url: ${obs.url || ""}`, `title: ${obs.title || ""}`, `format: ${format}`];
  if (obs.selector) lines.push(`selector: ${obs.selector}`);
  if (obs.truncated) lines.push("truncated: true");
  if (format === "html") {
    lines.push("html:", obs.html || "(empty)");
  } else if (format === "markdown") {
    lines.push(toMarkdown(obs.blocks || []) || obs.text || "(empty)");
    const links = Array.isArray(obs.links) ? obs.links : [];
    if (links.length > 0) {
      lines.push("", "links:");
      for (const link of links) lines.push(`- ${link.text || link.href} ${link.href || ""}`.trim());
    }
  } else {
    lines.push("text:", obs.text || "(empty)");
  }
  return lines.join("\n");
}

/**
 * @param {{ selector?: string, count?: number, truncated?: boolean, elements?: Array<Record<string, unknown>> }} result
 * @returns {string}
 */
export function formatQuery(result) {
  const elements = Array.isArray(result.elements) ? result.elements : [];
  const lines = [`selector: ${result.selector || ""}`, `matches: ${result.count ?? elements.length}`];
  if (result.truncated) lines.push("truncated: true");
  if (elements.length === 0) lines.push("(none)");
  for (const el of elements) lines.push(elementLine(el));
  lines.push("hint: these refs replace older refs. chrome_element reads one; chrome_click activates one.");
  return lines.join("\n");
}

/**
 * @param {Record<string, unknown> | null | undefined} el
 * @returns {string}
 */
export function formatElement(el) {
  if (!el || el.ok === false) return String(el?.error || "ref not found; call chrome_snapshot or chrome_query");
  const lines = [elementLine(el)];
  if (el.box && typeof el.box === "object") {
    const box = el.box;
    lines.push(`box: ${box.left},${box.top} ${box.width}x${box.height}`);
  }
  if (el.text) lines.push(`text: ${el.text}`);
  const attrs = el.attrs && typeof el.attrs === "object" ? el.attrs : null;
  if (attrs && Object.keys(attrs).length > 0) {
    lines.push("attributes:");
    for (const [key, value] of Object.entries(attrs)) lines.push(`- ${key}=${JSON.stringify(value)}`);
  }
  if (el.html) lines.push("html:", String(el.html));
  return lines.join("\n");
}

/**
 * @param {unknown} value
 * @param {boolean} truncated
 * @returns {string}
 */
export function formatEval(value, truncated) {
  let text = "undefined";
  if (value !== undefined) text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const shown = String(text ?? "undefined");
  const lines = ["result:", shown.slice(0, EVAL_OUTPUT_LIMIT)];
  if (truncated || shown.length > EVAL_OUTPUT_LIMIT) lines.push("truncated: true");
  return lines.join("\n");
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @returns {string}
 */
export function formatConsole(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [`console: ${list.length}`];
  if (list.length === 0) lines.push("(none)");
  for (const entry of list) lines.push(`[${entry.level || "log"}] ${entry.text || ""}`);
  return lines.join("\n");
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @param {{ text?: string, truncated?: boolean, redacted?: boolean } | null} [detail]
 * @returns {string}
 */
export function formatNetwork(entries, detail) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [`requests: ${list.length}`];
  if (list.length === 0) lines.push("(none)");
  for (const entry of list) {
    lines.push([entry.id, entry.method, entry.status || entry.failed, entry.type, entry.url].filter(Boolean).join(" "));
  }
  if (detail) {
    lines.push("body:", detail.text || "(empty)");
    if (detail.truncated) lines.push("truncated: true");
    if (detail.redacted) lines.push("redacted: secret-shaped fields");
  }
  lines.push("hint: headers are not returned. Pass request_id to read one redacted response body.");
  return lines.join("\n");
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} dir
 * @returns {string}
 */
export function formatDownloads(entries, dir) {
  const list = Array.isArray(entries) ? entries : [];
  const lines = [`dir: ${dir}`, "downloads:"];
  if (list.length === 0) lines.push("(none)");
  for (const entry of list) {
    lines.push([entry.state, entry.filename, entry.url].filter(Boolean).join(" "));
  }
  return lines.join("\n");
}

/** Page script: stamp controls, including offscreen and open shadow / same-origin frames. */
export const SNAPSHOT_SCRIPT = pageScript(`
  var interactive = ${JSON.stringify(INTERACTIVE)};
  var inView = [];
  var outside = [];
  dshWalk(document, function (el) {
    var matched = false;
    try { matched = el.matches && el.matches(interactive); } catch (error) { matched = false; }
    if (!matched || dshHidden(el)) return;
    var box = dshAbsBox(el);
    if (box.width < 2 || box.height < 2) return;
    if (dshInView(box)) inView.push(el);
    else outside.push(el);
  }, 0, { seen: 0 });
  window.__dshRefs = [];
  var elements = inView.slice(0, ${ELEMENT_LIMIT}).map(function (el) { return dshDescribe(el, dshRegister(el)); });
  var offscreen = outside.slice(0, ${OFFSCREEN_LIMIT}).map(function (el) { return dshDescribe(el, dshRegister(el)); });
  var headings = [];
  dshWalk(document, function (el) {
    if (headings.length >= 12 || !/^H[1-6]$/.test(el.tagName) || dshHidden(el)) return;
    var box = dshAbsBox(el);
    if (!dshInView(box)) return;
    var name = dshName(el);
    if (!name) return;
    headings.push({ level: Number(el.tagName.slice(1)), name: name });
  }, 0, { seen: 0 });
  var raw = (document.body && document.body.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return {
    url: location.href,
    title: document.title || "",
    text: raw.slice(0, ${TEXT_LIMIT}),
    truncatedText: raw.length > ${TEXT_LIMIT},
    headings: headings,
    elements: elements,
    offscreen: offscreen,
    offscreenCount: outside.length,
  };
`);

/**
 * @param {number} ref
 * @returns {string}
 */
export function boxScript(ref) {
  return pageScript(`
    var el = dshLookup(${ref});
    if (!el) return null;
    var node = el;
    while (node) {
      try { node.scrollIntoView({ block: "center", inline: "center" }); } catch (error) {}
      var view = node.ownerDocument && node.ownerDocument.defaultView;
      node = view && view.frameElement;
    }
    return dshAbsBox(el);
  `);
}

/**
 * @param {number} ref
 * @returns {string}
 */
export function focusScript(ref) {
  return pageScript(`
    var el = dshLookup(${ref});
    if (!el) return { ok: false, error: "ref not found" };
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (error) {}
    try { el.focus(); } catch (error) { return { ok: false, error: "element cannot be focused" }; }
    return { ok: true };
  `);
}

/**
 * @param {number} ref
 * @returns {string}
 */
export function scrollRefScript(ref) {
  return pageScript(`
    var el = dshLookup(${ref});
    if (!el) return { ok: false, error: "ref not found" };
    var node = el;
    while (node) {
      try { node.scrollIntoView({ block: "center", inline: "center" }); } catch (error) {}
      var view = node.ownerDocument && node.ownerDocument.defaultView;
      node = view && view.frameElement;
    }
    return { ok: true };
  `);
}

/**
 * @param {number} ref
 * @param {string} text
 * @param {boolean} clear
 * @returns {string}
 */
export function typeScript(ref, text, clear) {
  return pageScript(`
    var text = ${JSON.stringify(text)};
    var clear = ${clear ? "true" : "false"};
    var el = dshLookup(${ref});
    if (!el) return { ok: false, error: "ref not found" };
    var tag = el.tagName;
    var inputType = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "A" || tag === "BUTTON") return { ok: false, error: "use chrome_click for links and buttons" };
    if (inputType === "checkbox" || inputType === "radio") return { ok: false, error: "use chrome_click for checkboxes and radios" };
    if (inputType === "file") return { ok: false, error: "use chrome_upload for file inputs" };
    try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (error) {}
    try { el.focus(); } catch (error) {}
    if (tag === "SELECT") {
      var options = el.options ? Array.prototype.slice.call(el.options) : [];
      var match = options.find(function (option) { return option.value === text; })
        || options.find(function (option) { return option.label === text || option.text.trim() === text; });
      if (!match) return { ok: false, error: "option not found" };
      var selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      selectSetter.call(el, match.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, mode: "select" };
    }
    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      return { ok: true, mode: "contenteditable" };
    }
    var proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
    if (!setter) return { ok: false, error: "element is not editable" };
    setter.call(el, clear ? text : String(el.value || "") + text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, mode: "value" };
  `);
}

/**
 * @param {"up" | "down" | "top" | "bottom"} direction
 * @returns {string}
 */
export function scrollScript(direction) {
  if (direction === "down") return "window.scrollBy(0, Math.round(window.innerHeight * 0.8))";
  if (direction === "up") return "window.scrollBy(0, -Math.round(window.innerHeight * 0.8))";
  if (direction === "right") return "window.scrollBy(Math.round(window.innerWidth * 0.8), 0)";
  if (direction === "left") return "window.scrollBy(-Math.round(window.innerWidth * 0.8), 0)";
  if (direction === "top") return "window.scrollTo(0, 0)";
  return "window.scrollTo(0, document.documentElement.scrollHeight)";
}

function renderA11yNode(node, depth) {
  const pad = "  ".repeat(depth);
  const bits = [`${pad}- ${node.role || node.tag || "group"}`];
  if (node.name) bits.push(JSON.stringify(node.name));
  if (node.ref != null) bits.push(`[${node.ref}]`);
  if (node.value) bits.push(`value=${JSON.stringify(node.value)}`);
  const lines = [bits.join(" ")];
  for (const child of node.children || []) lines.push(renderA11yNode(child, depth + 1));
  return lines.join("\n");
}

/**
 * @param {{ filter?: string, count?: number, truncated?: boolean, tree?: Array<Record<string, unknown>> }} result
 * @returns {string}
 */
export function formatA11y(result) {
  const tree = Array.isArray(result.tree) ? result.tree : [];
  const lines = [`filter: ${result.filter || "interactive"}`, `nodes: ${result.count ?? 0}`];
  if (result.truncated) lines.push("truncated: true");
  if (tree.length === 0) lines.push("(none)");
  for (const node of tree) lines.push(renderA11yNode(node, 0));
  lines.push("hint: these refs replace older refs. chrome_click and chrome_fill use them.");
  return lines.join("\n");
}

/**
 * @param {{ query?: string, count?: number, elements?: Array<Record<string, unknown>> }} result
 * @returns {string}
 */
export function formatFind(result) {
  const elements = Array.isArray(result.elements) ? result.elements : [];
  const lines = [`query: ${result.query || ""}`, `matches: ${result.count ?? elements.length}`];
  if (elements.length === 0) lines.push("(none)");
  for (const el of elements) lines.push(elementLine(el));
  lines.push("hint: these refs replace older refs. Use a shorter query if the target is missing.");
  return lines.join("\n");
}

/**
 * @param {{ results?: Array<Record<string, unknown>> }} result
 * @returns {string}
 */
export function formatFill(result) {
  const results = Array.isArray(result.results) ? result.results : [];
  const lines = [`fields: ${results.length}`];
  for (const item of results) lines.push(`[${item.ref}] ${item.ok ? "ok" : item.error || "failed"}`);
  return lines.join("\n");
}

const AX_INTERACTIVE = /^(button|link|textbox|searchbox|combobox|checkbox|radio|tab|menuitem|switch|slider|option|spinbutton|listbox)$/i;
const AX_STRUCTURAL = /^(heading|navigation|main|image|banner|contentinfo|form|region)$/i;

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function axText(raw) {
  if (raw == null) return "";
  if (typeof raw === "string" || typeof raw === "number") return String(raw);
  if (typeof raw === "object" && "value" in raw) return String(raw.value ?? "");
  return "";
}

/**
 * Format a Chrome accessibility tree. Nodes use computed role and name.
 * @param {{ filter?: string, nodes?: Array<Record<string, unknown>>, depth?: number }} input
 * @returns {string}
 */
export function formatComputedA11y(input) {
  const filter = input.filter || "interactive";
  const nodes = Array.isArray(input.nodes) ? input.nodes : [];
  const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));
  const childrenOf = new Map();
  const childIds = new Set();
  for (const node of nodes) {
    const parent = node.parentId == null ? "" : String(node.parentId);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(node);
    for (const child of node.childIds || []) childIds.add(String(child));
  }
  const roots = nodes.filter((node) => !childIds.has(String(node.nodeId)) || !byId.has(String(node.parentId ?? "")));
  const lines = [`filter: ${filter}`, "source: accessibility-tree"];
  let count = 0;
  let truncated = false;
  const maxDepth = input.depth || 15;
  function keep(node) {
    if (node.ignored) return false;
    const role = axText(node.role);
    if (!role || role === "none" || role === "generic" || role === "InlineTextBox") return false;
    if (filter === "all") return AX_INTERACTIVE.test(role) || AX_STRUCTURAL.test(role) || Boolean(axText(node.name));
    return AX_INTERACTIVE.test(role);
  }
  function walk(node, depth) {
    if (count >= A11Y_NODE_LIMIT) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) return;
    const shown = keep(node);
    if (shown) {
      count += 1;
      const bits = [`${"  ".repeat(depth)}- ${axText(node.role) || "group"}`];
      const name = axText(node.name);
      if (name) bits.push(JSON.stringify(name.slice(0, 120)));
      if (node.ref != null) bits.push(`[${node.ref}]`);
      const value = axText(node.value);
      if (value) bits.push(`value=${JSON.stringify(value.slice(0, 80))}`);
      lines.push(bits.join(" "));
    }
    for (const child of childrenOf.get(String(node.nodeId)) || []) walk(child, shown ? depth + 1 : depth);
  }
  const start = roots.length ? roots : nodes.slice(0, 1);
  for (const root of start) walk(root, 0);
  lines.splice(2, 0, `nodes: ${count}`);
  if (truncated) lines.push("truncated: true");
  if (count === 0) lines.push("(none)");
  lines.push("hint: names and roles come from Chrome's accessibility tree. Refs replace older refs.");
  return lines.join("\n");
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @param {{ pattern?: string, onlyErrors?: boolean, limit?: number }} spec
 * @returns {Array<Record<string, unknown>>}
 */
export function selectConsole(entries, spec) {
  let list = Array.isArray(entries) ? entries.slice() : [];
  if (spec.onlyErrors) list = list.filter((entry) => entry.level === "error" || entry.level === "exception");
  if (spec.pattern) {
    let expression;
    try {
      expression = new RegExp(spec.pattern, "i");
    } catch {
      throw new Error("pattern is not a valid regular expression");
    }
    list = list.filter((entry) => expression.test(String(entry.text || "")));
  }
  return list.slice(-(spec.limit || 30));
}

/**
 * @param {Array<Record<string, unknown>>} entries
 * @param {string} url
 * @param {number} limit
 * @returns {Array<Record<string, unknown>>}
 */
export function selectNetwork(entries, url, limit) {
  let list = Array.isArray(entries) ? entries.slice() : [];
  const needle = String(url || "").trim().toLowerCase();
  if (needle) list = list.filter((entry) => String(entry.url || "").toLowerCase().includes(needle));
  return list.slice(-limit);
}

/**
 * @param {unknown} raw
 * @returns {Array<Record<string, unknown>>}
 */
export function assertBatch(raw) {
  const allowed = new Set(["click", "type", "press", "scroll", "wait", "fill", "navigate", "hover"]);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("actions is required");
  if (raw.length > 12) throw new Error("at most 12 actions");
  return raw.map((step, index) => {
    if (!step || typeof step !== "object") throw new Error(`actions[${index}] must be an object`);
    const action = String(step.action || "").trim();
    if (!allowed.has(action)) throw new Error(`actions[${index}].action must be one of: ${[...allowed].join(", ")}`);
    return { ...step, action };
  });
}

/**
 * @param {Array<Record<string, unknown>>} cookies
 * @param {boolean} showValues
 * @returns {string}
 */
export function formatCookies(cookies, showValues) {
  const list = Array.isArray(cookies) ? cookies : [];
  const lines = [`cookies: ${list.length}`];
  if (list.length === 0) lines.push("(none)");
  for (const cookie of list.slice(0, 40)) {
    const name = String(cookie.name || "");
    const secret = SECRET_KEY.test(name);
    const value = !showValues || secret ? "••••" : String(cookie.value || "");
    lines.push(`${name} ${cookie.domain || ""} ${secret ? "redacted" : value}`.trim());
  }
  if (!showValues) lines.push("hint: values are hidden unless show_values is true. Secret-shaped names stay redacted.");
  return lines.join("\n");
}

/**
 * @param {string} area
 * @param {Array<Record<string, unknown>>} items
 * @param {boolean} showValues
 * @returns {string}
 */
export function formatStorage(area, items, showValues) {
  const list = Array.isArray(items) ? items : [];
  const lines = [`${area}: ${list.length}`];
  if (list.length === 0) lines.push("(none)");
  for (const item of list.slice(0, 40)) {
    const name = String(item.name || "");
    const secret = SECRET_KEY.test(name);
    const value = !showValues || secret ? "••••" : String(item.value || "").slice(0, 200);
    lines.push(`${name}=${value}`);
  }
  return lines.join("\n");
}

/**
 * @param {{ filter: string, depth: number, ref: number | null }} spec
 * @returns {string}
 */
export function a11yScript(spec) {
  return pageScript(`
    var filter = ${JSON.stringify(spec.filter)};
    var maxDepth = ${spec.depth};
    var rootRef = ${spec.ref == null ? "null" : String(spec.ref)};
    var limit = ${A11Y_NODE_LIMIT};
    var root = rootRef == null ? (document.body || document.documentElement) : dshLookup(rootRef);
    if (!root) return { ok: false, error: "ref not found" };
    var count = 0;
    var truncated = false;
    function roleOf(el) {
      var explicit = el.getAttribute("role");
      if (explicit) return explicit;
      var tag = el.tagName;
      if (tag === "A" && el.href) return "link";
      if (tag === "BUTTON") return "button";
      if (tag === "SELECT") return "combobox";
      if (tag === "TEXTAREA") return "textbox";
      if (tag === "SUMMARY") return "button";
      if (tag === "INPUT") {
        var type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "hidden" || type === "file") return "";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        return "textbox";
      }
      if (/^H[1-6]$/.test(tag)) return "heading";
      if (tag === "NAV") return "navigation";
      if (tag === "MAIN") return "main";
      if (tag === "IMG") return "image";
      if (el.isContentEditable) return "textbox";
      return "";
    }
    function isInteractive(role) {
      return /button|link|textbox|searchbox|combobox|checkbox|radio|tab|menuitem|switch|slider|option/.test(role);
    }
    function walk(el, depth) {
      if (!el || el.nodeType !== 1 || depth > maxDepth) return [];
      var kids = [];
      var children = el.children ? Array.prototype.slice.call(el.children) : [];
      if (el.shadowRoot) children = children.concat(Array.prototype.slice.call(el.shadowRoot.children || []));
      for (var i = 0; i < children.length; i += 1) kids = kids.concat(walk(children[i], depth + 1));
      if (el.tagName === "IFRAME") {
        try { if (el.contentDocument && el.contentDocument.body) kids = kids.concat(walk(el.contentDocument.body, depth + 1)); } catch (error) {}
      }
      var role = roleOf(el);
      var keep = filter === "interactive" ? isInteractive(role) : Boolean(role);
      if (!keep) return kids;
      if (count >= limit) { truncated = true; return kids; }
      count += 1;
      return [{
        role: role,
        name: dshName(el),
        ref: dshRegister(el),
        value: "value" in el ? String(el.value || "").slice(0, 80) : "",
        children: kids,
      }];
    }
    window.__dshRefs = [];
    var tree = walk(root, 0);
    return { ok: true, filter: filter, count: count, truncated: truncated, tree: tree };
  `);
}

/**
 * @param {string} query
 * @param {number} limit
 * @returns {string}
 */
export function findScript(query, limit) {
  return pageScript(`
    var query = ${JSON.stringify(query)}.toLowerCase();
    var tokens = query.split(/\\s+/).filter(Boolean);
    var limit = ${limit};
    var found = [];
    dshWalk(document, function (el) {
      if (dshHidden(el)) return;
      var role = el.getAttribute("role") || el.tagName.toLowerCase();
      var name = dshName(el).toLowerCase();
      var text = (el.innerText || "").replace(/\\s+/g, " ").trim().toLowerCase().slice(0, 160);
      var hay = role + " " + name + " " + text;
      if (!tokens.every(function (token) { return hay.indexOf(token) !== -1; })) return;
      var score = tokens.length;
      if (name === query) score += 10;
      else if (name && name.indexOf(query) !== -1) score += 5;
      else if (text.indexOf(query) !== -1) score += 2;
      found.push({ el: el, score: score });
    }, 0, { seen: 0 });
    found.sort(function (a, b) { return b.score - a.score; });
    window.__dshRefs = [];
    var elements = found.slice(0, limit).map(function (item) {
      var described = dshDescribe(item.el, dshRegister(item.el));
      described.score = item.score;
      return described;
    });
    return { ok: true, query: query, count: found.length, elements: elements };
  `);
}

/**
 * @param {Array<{ ref: number, value: string }>} fields
 * @returns {string}
 */
export function fillScript(fields) {
  return pageScript(`
    var fields = ${JSON.stringify(fields)};
    function setField(el, value) {
      var tag = el.tagName;
      var type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "A" || tag === "BUTTON") return { ok: false, error: "use chrome_click" };
      if (type === "file") return { ok: false, error: "use chrome_upload" };
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (error) {}
      if (type === "checkbox" || type === "radio") {
        var on = value === "true" || value === "1" || value === "on" || value === "yes";
        if (type === "radio") el.checked = true;
        else el.checked = on;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      if (tag === "SELECT") {
        var options = el.options ? Array.prototype.slice.call(el.options) : [];
        var match = options.find(function (option) { return option.value === value; })
          || options.find(function (option) { return option.label === value || option.text.trim() === value; });
        if (!match) return { ok: false, error: "option not found" };
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, match.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      }
      if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { ok: true };
      }
      var proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
      if (!setter) return { ok: false, error: "element is not editable" };
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    var results = [];
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      var el = dshLookup(field.ref);
      if (!el) results.push({ ref: field.ref, ok: false, error: "ref not found" });
      else {
        var set = setField(el, field.value);
        results.push({ ref: field.ref, ok: set.ok, error: set.error || "" });
      }
    }
    return { ok: results.every(function (item) { return item.ok; }), results: results };
  `);
}

/**
 * @param {string} selector
 * @param {number | null} ref
 * @returns {string}
 */
export function textScript(selector, ref) {
  return pageScript(`
    var selector = ${JSON.stringify(selector || "")};
    var ref = ${ref == null ? "null" : String(ref)};
    var root = document.body;
    if (ref !== null) {
      root = dshLookup(ref);
      if (!root) return { ok: false, error: "ref not found" };
    } else if (selector) {
      var found = dshFind(selector, 1);
      if (!found.ok) return found;
      root = found.found[0];
      if (!root) return { ok: false, error: "selector matched nothing" };
    }
    var raw = (root && (root.innerText || root.textContent) || "").replace(/\\n{3,}/g, "\\n\\n").trim();
    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      selector: selector,
      ref: ref,
      text: raw.slice(0, ${TEXT_READ_LIMIT}),
      truncated: raw.length > ${TEXT_READ_LIMIT},
    };
  `);
}

/**
 * @param {string} selector
 * @param {"text" | "html" | "markdown"} format
 * @returns {string}
 */
export function contentScript(selector, format) {
  return pageScript(`
    var selector = ${JSON.stringify(selector || "")};
    var format = ${JSON.stringify(format)};
    var root = document.body;
    if (selector) {
      var found = dshFind(selector, 1);
      if (!found.ok) return found;
      root = found.found[0];
      if (!root) return { ok: false, error: "selector matched nothing" };
    } else {
      root = document.querySelector("article, main") || document.body;
    }
    if (!root) return { ok: false, error: "page has no body" };
    var raw = (root.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim();
    var html = "";
    if (format === "html") {
      var clone = root.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, svg, canvas, iframe").forEach(function (node) { node.remove(); });
      html = clone.outerHTML || clone.innerHTML || "";
    }
    var blocks = [];
    var links = [];
    if (format === "markdown") {
      var nodes = root.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, pre, blockquote");
      for (var i = 0; i < nodes.length && blocks.length < ${MARKDOWN_BLOCKS}; i += 1) {
        var node = nodes[i];
        if (node.closest("nav, footer, script, style")) continue;
        var blockText = (node.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 500);
        if (!blockText) continue;
        var tag = node.tagName;
        blocks.push({
          tag: tag === "PRE" ? "pre" : /^H[1-6]$/.test(tag) ? "h" : tag === "LI" ? "li" : "p",
          level: /^H[1-6]$/.test(tag) ? Number(tag.slice(1)) : 0,
          text: blockText,
        });
      }
      var anchors = root.querySelectorAll("a[href]");
      for (var j = 0; j < anchors.length && links.length < 40; j += 1) {
        var anchor = anchors[j];
        var label = (anchor.innerText || anchor.getAttribute("aria-label") || anchor.href || "").replace(/\\s+/g, " ").trim().slice(0, 120);
        if (!label) continue;
        links.push({ text: label, href: anchor.href });
      }
    }
    return {
      ok: true,
      url: location.href,
      title: document.title || "",
      format: format,
      selector: selector,
      text: raw.slice(0, ${TEXT_READ_LIMIT}),
      html: html.slice(0, ${HTML_LIMIT}),
      blocks: blocks,
      links: links,
      truncated: raw.length > ${TEXT_READ_LIMIT} || html.length > ${HTML_LIMIT},
    };
  `);
}

/**
 * @param {string} selector
 * @param {number} limit
 * @returns {string}
 */
export function queryScript(selector, limit) {
  return pageScript(`
    var selector = ${JSON.stringify(selector)};
    var limit = ${limit};
    var found = dshFind(selector, limit + 1);
    if (!found.ok) return found;
    window.__dshRefs = [];
    var truncated = found.found.length > limit;
    var elements = found.found.slice(0, limit).map(function (el) { return dshDescribe(el, dshRegister(el)); });
    return { ok: true, selector: selector, count: found.found.length, truncated: truncated, elements: elements };
  `);
}

/**
 * @param {number} ref
 * @returns {string}
 */
export function elementScript(ref) {
  return pageScript(`
    var el = dshLookup(${ref});
    if (!el) return { ok: false, error: "ref not found" };
    var attrs = {};
    ["id", "name", "type", "role", "href", "placeholder", "aria-label", "title", "alt", "value"].forEach(function (key) {
      var value = el.getAttribute(key);
      if (value) attrs[key] = value.slice(0, 200);
    });
    var className = typeof el.className === "string" ? el.className.trim() : "";
    if (className) attrs["class"] = className.slice(0, 200);
    var described = dshDescribe(el, ${ref});
    described.ok = true;
    described.text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 1000);
    described.attrs = attrs;
    described.html = (el.outerHTML || "").slice(0, 2000);
    return described;
  `);
}

/**
 * @param {number} ref
 * @returns {string}
 */
export function fileInputScript(ref) {
  return pageScript(`
    var el = dshLookup(${ref});
    if (!el) throw new Error("ref not found");
    if (el.tagName !== "INPUT" || (el.getAttribute("type") || "").toLowerCase() !== "file") {
      throw new Error("ref is not a file input");
    }
    return el;
  `);
}

/**
 * @param {{ selector: string, text: string, url: string, state: "visible" | "hidden" }} spec
 * @returns {string}
 */
export function waitCheckScript(spec) {
  return pageScript(`
    var selector = ${JSON.stringify(spec.selector)};
    var text = ${JSON.stringify(spec.text)};
    var urlPart = ${JSON.stringify(spec.url)};
    var state = ${JSON.stringify(spec.state)};
    if (urlPart && location.href.indexOf(urlPart) === -1) return { ok: false, reason: "url does not match" };
    if (text && (document.body && document.body.innerText || "").indexOf(text) === -1) return { ok: false, reason: "text not found" };
    if (selector) {
      var found = dshFind(selector, 8);
      if (!found.ok) return { ok: false, reason: found.error };
      var visible = found.found.some(function (el) {
        if (dshHidden(el)) return false;
        return dshInView(dshAbsBox(el));
      });
      var matched = found.found.length > 0;
      if (state === "hidden") {
        if (matched && visible) return { ok: false, reason: "selector still visible" };
      } else if (!visible) {
        return { ok: false, reason: matched ? "selector not in view" : "selector not found" };
      }
    }
    return { ok: true };
  `);
}

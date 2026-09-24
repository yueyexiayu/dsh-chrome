(() => {
  if (globalThis.__dshPickerInstalled) return;
  globalThis.__dshPickerInstalled = true;

  const MAX = 12;
  const INTENTS = [
    { id: "change", label: "改变" },
    { id: "ask", label: "疑问" },
  ];
  const STYLE_KEYS = ["display", "width", "height", "margin", "padding", "color", "border", "border-radius", "font-family", "font-size", "font-weight", "text-align"];
  let active = false;
  let notes = [];
  let draftEl = null;
  let draftIntent = "change";
  let hovered = null;
  let layer = null;
  let editor = null;
  let noteInput = null;
  let listPanel = null;
  let hint = null;
  let port = null;
  let pendingSend = false;

  function fromPicker(event) {
    return event.composedPath().some((node) => node instanceof Element && node.hasAttribute("data-dsh-picker"));
  }

  function selectorOf(el) {
    if (!(el instanceof Element)) return "";
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return `#${CSS.escape(el.id)}`;
    }
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && depth < 6) {
      let part = node.tagName.toLowerCase();
      const testid = node.getAttribute("data-testid");
      if (testid) {
        part += `[data-testid="${CSS.escape(testid)}"]`;
        parts.unshift(part);
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
      depth += 1;
    }
    return parts.join(" > ").slice(0, 500);
  }

  function textOf(el) {
    return (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 400);
  }

  function targetAt(event) {
    const stack = document.elementsFromPoint(event.clientX, event.clientY);
    for (const el of stack) {
      if (!(el instanceof Element) || el.hasAttribute("data-dsh-picker")) continue;
      return el;
    }
    return null;
  }

  function classToken(el) {
    const name = [...el.classList].find((item) => /^[A-Za-z][\w-]*$/.test(item));
    return name ? `.${CSS.escape(name)}` : "";
  }

  function shortPart(el) {
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `${tag}#${CSS.escape(el.id)}`;
    return tag + classToken(el);
  }

  function shortSelector(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && node !== document.body && depth < 4; depth += 1) {
      parts.unshift(shortPart(node));
      const selector = parts.join(" > ");
      try {
        if (document.querySelectorAll(selector).length === 1) return selector.slice(0, 500);
      } catch {
        // keep the path even if a class is not a valid selector
      }
      node = node.parentElement;
    }
    return (parts.join(" > ") || selectorOf(el)).slice(0, 500);
  }

  function locationPart(el) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    if (role) return `${tag}[role="${role.slice(0, 40)}"]`;
    const label = el.getAttribute("aria-label");
    if (label) return `${tag}[aria-label="${label.slice(0, 80)}"]`;
    return classToken(el) || tag;
  }

  function ancestorChain(el, part) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 12) {
      parts.unshift(part(node));
      node = node.parentElement;
    }
    return parts.join(" > ").slice(0, 800);
  }

  function domPart(el) {
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].slice(0, 4).filter((name) => /^[\w-]+$/.test(name));
    return classes.length ? `${tag}.${classes.join(".")}` : tag;
  }

  function computedOf(el) {
    const style = getComputedStyle(el);
    const out = {};
    for (const key of STYLE_KEYS) out[key] = style.getPropertyValue(key);
    return out;
  }

  function describe(el) {
    const rect = el.getBoundingClientRect();
    const text = textOf(el);
    const tag = el.tagName.toLowerCase();
    return {
      tag,
      intent: "change",
      selector: shortSelector(el),
      location: ancestorChain(el, locationPart),
      domPath: ancestorChain(el, domPart),
      role: el.getAttribute("role") || tag,
      name: (el.getAttribute("aria-label") || el.getAttribute("alt") || "").slice(0, 200) || text.slice(0, 80),
      text,
      bounds: `x=${Math.round(rect.left)}, y=${Math.round(rect.top)}, ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      styles: computedOf(el),
      html: (el.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 800),
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  }

  function markBox(el, label, hover) {
    const rect = el.getBoundingClientRect();
    const node = document.createElement("div");
    node.setAttribute("data-dsh-picker", "1");
    node.style.cssText = [
      "position:fixed",
      "pointer-events:none",
      "z-index:2147483646",
      "box-sizing:border-box",
      "border:2px solid #e23d3d",
      `background:${hover ? "rgba(226,61,61,0.08)" : "rgba(226,61,61,0.16)"}`,
      `left:${rect.left}px`,
      `top:${rect.top}px`,
      `width:${Math.max(0, rect.width)}px`,
      `height:${Math.max(0, rect.height)}px`,
    ].join(";");
    if (label) {
      const tag = document.createElement("span");
      tag.setAttribute("data-dsh-picker", "1");
      tag.textContent = label;
      tag.style.cssText = "position:absolute;left:0;top:0;background:#e23d3d;color:#fff;font:12px sans-serif;line-height:16px;padding:0 4px;";
      node.append(tag);
    }
    return node;
  }

  function redraw() {
    if (!layer) return;
    layer.replaceChildren();
    const seen = new Map();
    notes.forEach((item, index) => {
      if (!item.el || !item.el.isConnected) return;
      const marks = seen.get(item.el) || [];
      marks.push(String(index + 1));
      seen.set(item.el, marks);
    });
    for (const [el, marks] of seen) layer.append(markBox(el, marks.join(","), false));
    const focus = draftEl && draftEl.isConnected ? draftEl : hovered;
    if (focus && !seen.has(focus)) layer.append(markBox(focus, "", true));
    const hintText = hint && hint.querySelector("[data-dsh-hint]");
    if (hintText) hintText.textContent = notes.length ? `${notes.length} 条注释` : "点击元素，写下要改的内容";
  }

  function cardStyle(extra) {
    return [
      "position:fixed",
      "z-index:2147483647",
      "box-sizing:border-box",
      "background:#2b2b2b",
      "color:#f5f5f5",
      "border:1px solid #3d3d3d",
      "border-radius:14px",
      "box-shadow:0 16px 40px rgba(0,0,0,0.35)",
      "font:13px/1.4 sans-serif",
      extra,
    ].join(";");
  }

  function button(label, action, primary) {
    const el = document.createElement("button");
    el.type = "button";
    el.dataset.dshAction = action;
    el.setAttribute("data-dsh-picker", "1");
    el.textContent = label;
    el.style.cssText = primary
      ? "font:600 13px sans-serif;padding:8px 14px;border-radius:8px;border:0;background:#d9d9d9;color:#1f2328;cursor:pointer;"
      : "font:13px sans-serif;padding:8px 12px;border-radius:8px;border:1px solid #4a4a4a;background:#3a3a3a;color:#f5f5f5;cursor:pointer;";
    return el;
  }

  function placeEditor(el) {
    if (!editor) return;
    const rect = el.getBoundingClientRect();
    const width = 360;
    const height = 340;
    let left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 8);
    editor.style.left = `${left}px`;
    editor.style.top = `${top}px`;
  }

  function closeEditor() {
    editor?.remove();
    editor = null;
    noteInput = null;
    draftEl = null;
    redraw();
  }

  function refreshEditorLabels() {
    if (!editor || !draftEl) return;
    const detail = describe(draftEl);
    const title = editor.querySelector("[data-dsh-title]");
    const selector = editor.querySelector("[data-dsh-selector]");
    if (title) title.textContent = detail.name || detail.tag;
    if (selector) selector.textContent = detail.selector || "(none)";
    placeEditor(draftEl);
  }

  function setDraftIntent(id) {
    draftIntent = id;
    editor?.querySelectorAll("[data-dsh-intent]").forEach((node) => {
      const on = node.dataset.dshIntent === id;
      node.style.background = on ? "#4a4a4a" : "transparent";
      node.style.color = on ? "#fff" : "#c8c8c8";
    });
  }

  function openEditor(el) {
    if (notes.length >= MAX && !draftEl) return;
    draftEl = el;
    draftIntent = "change";
    editor?.remove();
    editor = document.createElement("div");
    editor.setAttribute("data-dsh-picker", "1");
    editor.style.cssText = cardStyle("width:360px;padding:14px;");
    const title = document.createElement("div");
    title.dataset.dshTitle = "1";
    title.setAttribute("data-dsh-picker", "1");
    title.style.cssText = "font:600 16px sans-serif;margin-bottom:4px;";
    const selector = document.createElement("div");
    selector.dataset.dshSelector = "1";
    selector.setAttribute("data-dsh-picker", "1");
    selector.style.cssText = "color:#bdbdbd;font:12px ui-monospace,monospace;margin-bottom:10px;word-break:break-all;";
    noteInput = document.createElement("textarea");
    noteInput.setAttribute("data-dsh-picker", "1");
    noteInput.dataset.dshInput = "note";
    noteInput.placeholder = "描述智能体应该在这里改变什么……";
    noteInput.style.cssText = "width:100%;height:96px;box-sizing:border-box;resize:vertical;border:0;border-radius:8px;background:#111;color:#fff;padding:10px;font:14px sans-serif;";
    const intentLabel = document.createElement("div");
    intentLabel.setAttribute("data-dsh-picker", "1");
    intentLabel.textContent = "意图";
    intentLabel.style.cssText = "margin:12px 0 6px;color:#bdbdbd;font-size:12px;";
    const intentRow = document.createElement("div");
    intentRow.setAttribute("data-dsh-picker", "1");
    intentRow.style.cssText = "display:flex;border:1px solid #4a4a4a;border-radius:10px;overflow:hidden;";
    for (const item of INTENTS) {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.dataset.dshAction = "intent";
      choice.dataset.dshIntent = item.id;
      choice.setAttribute("data-dsh-picker", "1");
      choice.textContent = item.label;
      choice.style.cssText = "flex:1;border:0;padding:8px;background:transparent;color:#c8c8c8;cursor:pointer;font:13px sans-serif;";
      intentRow.append(choice);
    }
    const footer = document.createElement("div");
    footer.setAttribute("data-dsh-picker", "1");
    footer.style.cssText = "display:flex;justify-content:flex-end;gap:8px;align-items:center;margin-top:12px;";
    const climbButton = button("上一层", "up", false);
    climbButton.style.marginRight = "auto";
    footer.append(climbButton, button("取消", "cancel-edit", false), button("添加", "add", true));
    editor.append(title, selector, noteInput, intentLabel, intentRow, footer);
    document.documentElement.append(editor);
    refreshEditorLabels();
    setDraftIntent("change");
    noteInput.focus();
    redraw();
  }

  function addNote() {
    if (!draftEl || !draftEl.isConnected) return;
    const note = (noteInput?.value || "").trim().slice(0, 1000);
    if (!note) {
      noteInput?.focus();
      return;
    }
    if (notes.length >= MAX) return;
    notes.push({ el: draftEl, intent: draftIntent, note, detail: describe(draftEl) });
    closeEditor();
    renderList();
  }

  function removeNote(index) {
    notes.splice(index, 1);
    renderList();
    redraw();
  }

  function clearNotes() {
    notes = [];
    renderList();
    redraw();
  }

  function copyNotes() {
    const text = notes.map((item, index) => {
      const detail = item.detail || {};
      return [`${index + 1}. ${detail.name || detail.selector || "元素"}`, item.note, item.intent, detail.selector].filter(Boolean).join("\n");
    }).join("\n\n");
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("data-dsh-picker", "1");
    document.documentElement.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }

  function renderList() {
    listPanel?.remove();
    listPanel = null;
    if (!notes.length) return;
    listPanel = document.createElement("div");
    listPanel.setAttribute("data-dsh-picker", "1");
    listPanel.style.cssText = cardStyle("top:16px;right:16px;width:320px;padding:10px;");
    const header = document.createElement("div");
    header.setAttribute("data-dsh-picker", "1");
    header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px;";
    const title = document.createElement("strong");
    title.setAttribute("data-dsh-picker", "1");
    title.textContent = `${notes.length} 条注释`;
    title.style.marginRight = "auto";
    header.append(title, button("发送", "send", true), button("复制", "copy", false), button("清空", "clear", false));
    listPanel.append(header);
    notes.forEach((item, index) => {
      const row = document.createElement("div");
      row.setAttribute("data-dsh-picker", "1");
      row.style.cssText = "display:flex;gap:8px;padding:8px 0;border-top:1px solid #3d3d3d;";
      const badge = document.createElement("span");
      badge.setAttribute("data-dsh-picker", "1");
      badge.textContent = String(index + 1);
      badge.style.cssText = "width:22px;height:22px;border-radius:50%;background:#f5f5f5;color:#1f2328;text-align:center;line-height:22px;flex:none;";
      const body = document.createElement("div");
      body.setAttribute("data-dsh-picker", "1");
      body.style.cssText = "min-width:0;flex:1;";
      const name = document.createElement("div");
      name.setAttribute("data-dsh-picker", "1");
      name.textContent = item.detail?.name || item.detail?.selector || "元素";
      name.style.cssText = "font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      const comment = document.createElement("div");
      comment.setAttribute("data-dsh-picker", "1");
      comment.textContent = item.note;
      comment.style.cssText = "color:#d0d0d0;margin-top:2px;white-space:pre-wrap;";
      const intent = document.createElement("div");
      intent.setAttribute("data-dsh-picker", "1");
      intent.textContent = item.intent;
      intent.style.cssText = "color:#9a9a9a;margin-top:2px;font-size:12px;";
      body.append(name, comment, intent);
      const remove = button("×", "remove", false);
      remove.dataset.dshIndex = String(index);
      remove.style.cssText = "border:0;background:transparent;color:#f5f5f5;cursor:pointer;font-size:16px;";
      row.append(badge, body, remove);
      listPanel.append(row);
    });
    document.documentElement.append(listPanel);
  }

  function hideChrome(hidden) {
    const value = hidden ? "none" : "";
    if (layer) layer.style.display = value;
    if (editor) editor.style.display = value;
    if (listPanel) listPanel.style.display = value;
    if (hint) hint.style.display = value;
  }

  function noteItem(item) {
    const live = item.el && item.el.isConnected ? describe(item.el) : (item.detail || {});
    return { ...live, intent: item.intent, note: item.note };
  }

  function payload() {
    return {
      type: "dsh-pick",
      url: location.href,
      title: document.title || "",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      items: notes.map(noteItem),
    };
  }

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "dsh-pick" });
    port.onMessage.addListener((res) => {
      if (!pendingSend) return;
      pendingSend = false;
      if (!res || !res.ok) {
        hideChrome(false);
        if (hint) hint.textContent = (res && res.error) || "没送出";
        return;
      }
      stop();
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!pendingSend) return;
      pendingSend = false;
      hideChrome(false);
      if (hint) hint.textContent = "扩展连接断了，请重试";
    });
    return port;
  }

  function send() {
    if (!notes.length || pendingSend) return;
    pendingSend = true;
    if (hint) hint.textContent = "正在发送…";
    hideChrome(true);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!pendingSend) return;
      try {
        ensurePort().postMessage(payload());
      } catch (error) {
        pendingSend = false;
        hideChrome(false);
        if (hint) hint.textContent = error instanceof Error ? error.message : "没送出";
      }
    }));
  }

  function climbDraft() {
    const parent = draftEl && draftEl.parentElement;
    if (!parent || parent === document.documentElement || parent.hasAttribute("data-dsh-picker")) return;
    draftEl = parent;
    refreshEditorLabels();
    redraw();
  }

  function pickerAction(event) {
    const node = event.composedPath().find((item) => item instanceof Element && item.dataset && item.dataset.dshAction);
    return node || null;
  }

  function onMove(event) {
    if (!active || fromPicker(event) || pendingSend || editor) return;
    const el = targetAt(event);
    if (el === hovered) return;
    hovered = el;
    redraw();
  }

  function onDown(event) {
    if (!active) return;
    event.stopPropagation();
    const target = event.target;
    if (target instanceof Element && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
    event.preventDefault();
  }

  function onClick(event) {
    if (!active || pendingSend) return;
    const control = pickerAction(event);
    if (control) {
      event.preventDefault();
      event.stopPropagation();
      const action = control.dataset.dshAction;
      if (action === "send") send();
      else if (action === "add") addNote();
      else if (action === "copy") copyNotes();
      else if (action === "clear") clearNotes();
      else if (action === "cancel-edit") closeEditor();
      else if (action === "up") climbDraft();
      else if (action === "intent") setDraftIntent(control.dataset.dshIntent || "change");
      else if (action === "remove") removeNote(Number(control.dataset.dshIndex));
      else if (action === "cancel") stop();
      return;
    }
    if (fromPicker(event) || editor) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const el = targetAt(event);
    if (!el) return;
    if (notes.length >= MAX) {
      if (hint) hint.textContent = `最多 ${MAX} 条`;
      return;
    }
    openEditor(el);
  }

  function onKey(event) {
    if (!active) return;
    const typing = event.target instanceof Element && event.target.dataset && event.target.dataset.dshInput === "note";
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (editor) closeEditor();
      else stop();
      return;
    }
    if (typing && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      addNote();
      return;
    }
    if (typing) return;
    if (event.key === "Enter" && notes.length && !editor) {
      event.preventDefault();
      event.stopPropagation();
      send();
    }
  }

  function onLayout() {
    if (!active || pendingSend) return;
    if (draftEl) placeEditor(draftEl);
    redraw();
  }

  function stop() {
    active = false;
    notes = [];
    hovered = null;
    pendingSend = false;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mousedown", onDown, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("contextmenu", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onLayout, true);
    window.removeEventListener("resize", onLayout, true);
    if (port) {
      try { port.disconnect(); } catch { /* already gone */ }
      port = null;
    }
    closeEditor();
    listPanel?.remove();
    layer?.remove();
    hint?.remove();
    listPanel = null;
    layer = null;
    hint = null;
  }

  function start() {
    if (active) return;
    active = true;
    notes = [];
    layer = document.createElement("div");
    layer.setAttribute("data-dsh-picker", "1");
    hint = document.createElement("div");
    hint.setAttribute("data-dsh-picker", "1");
    hint.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:10px;background:#2b2b2b;color:#f5f5f5;font:13px sans-serif;";
    const hintText = document.createElement("span");
    hintText.dataset.dshHint = "1";
    hintText.setAttribute("data-dsh-picker", "1");
    hintText.textContent = "点击元素，写下要改的内容";
    hint.append(hintText);
    const exit = button("退出", "cancel", false);
    exit.style.marginLeft = "8px";
    hint.append(exit);
    document.documentElement.append(layer, hint);
    ensurePort();
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("contextmenu", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onLayout, true);
    window.addEventListener("resize", onLayout, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "dsh-pick-start") return;
    if (active) {
      stop();
      sendResponse({ ok: true, cancelled: true });
      return;
    }
    start();
    sendResponse({ ok: true });
  });
})();

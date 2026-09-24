(() => {
  if (globalThis.__dshPickerInstalled) return;
  globalThis.__dshPickerInstalled = true;

  const MAX = 12;
  const INTENTS = [
    { id: "change", label: "改" },
    { id: "ask", label: "问" },
    { id: "remove", label: "删" },
  ];
  const STYLE_KEYS = ["display", "width", "height", "margin", "padding", "color", "border", "border-radius", "font-family", "font-size", "font-weight", "text-align"];
  let active = false;
  let intent = "change";
  let intentButton = null;
  let selected = [];
  let hovered = null;
  let layer = null;
  let bar = null;
  let status = null;
  let sendButton = null;
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
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!(el instanceof Element) || el.hasAttribute("data-dsh-picker")) return null;
    return el;
  }

  function setStatus(text) {
    if (status) status.textContent = text;
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
    selected.forEach((el, index) => layer.append(markBox(el, String(index + 1), false)));
    if (hovered && !selected.includes(hovered)) layer.append(markBox(hovered, "", true));
    setStatus(selected.length ? `已选 ${selected.length} 个` : "点击添加，可多选");
    if (sendButton) sendButton.disabled = selected.length === 0;
  }

  function toggle(el) {
    const index = selected.indexOf(el);
    if (index >= 0) {
      selected.splice(index, 1);
      redraw();
      return;
    }
    if (selected.length >= MAX) {
      setStatus(`最多 ${MAX} 个`);
      return;
    }
    selected.push(el);
    redraw();
  }

  function climb() {
    const current = selected[selected.length - 1] || hovered;
    const parent = current && current.parentElement;
    if (!parent || parent === document.documentElement || parent.hasAttribute("data-dsh-picker")) return;
    const index = selected.indexOf(current);
    if (index >= 0) selected[index] = parent;
    else if (selected.length < MAX) selected.push(parent);
    hovered = parent;
    redraw();
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
      intent,
      selector: shortSelector(el),
      location: ancestorChain(el, locationPart),
      domPath: ancestorChain(el, domPart),
      role: el.getAttribute("role") || tag,
      name: (el.getAttribute("aria-label") || el.getAttribute("alt") || text).slice(0, 200),
      text,
      bounds: `x=${Math.round(rect.left)}, y=${Math.round(rect.top)}, ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      styles: computedOf(el),
      html: (el.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 800),
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  }

  function payload() {
    return {
      type: "dsh-pick",
      url: location.href,
      title: document.title || "",
      viewport: { width: window.innerWidth, height: window.innerHeight },
      items: selected.map(describe),
    };
  }

  function hideChrome(hidden) {
    if (layer) layer.style.display = hidden ? "none" : "";
    if (bar) bar.style.visibility = hidden ? "hidden" : "visible";
  }

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connect({ name: "dsh-pick" });
    port.onMessage.addListener((res) => {
      if (!pendingSend) return;
      pendingSend = false;
      if (!res || !res.ok) {
        hideChrome(false);
        if (sendButton) sendButton.disabled = selected.length === 0;
        setStatus((res && res.error) || "没送出");
        return;
      }
      stop();
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!pendingSend) return;
      pendingSend = false;
      hideChrome(false);
      if (sendButton) sendButton.disabled = selected.length === 0;
      setStatus("扩展连接断了，请重试");
    });
    return port;
  }

  function cycleIntent() {
    const index = INTENTS.findIndex((item) => item.id === intent);
    const next = INTENTS[(index + 1) % INTENTS.length];
    intent = next.id;
    if (intentButton) intentButton.textContent = next.label;
  }

  function send() {
    if (!selected.length || pendingSend) {
      if (!pendingSend) setStatus("先点一个元素");
      return;
    }
    pendingSend = true;
    if (sendButton) sendButton.disabled = true;
    setStatus("正在发送…");
    hideChrome(true);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!pendingSend) return;
      try {
        ensurePort().postMessage(payload());
      } catch (error) {
        pendingSend = false;
        hideChrome(false);
        if (sendButton) sendButton.disabled = false;
        setStatus(error instanceof Error ? error.message : "没送出");
      }
    }));
  }

  function onMove(event) {
    if (!active || fromPicker(event) || pendingSend) return;
    const el = targetAt(event);
    if (el === hovered) return;
    hovered = el;
    redraw();
  }

  function pickerAction(event) {
    const node = event.composedPath().find((item) => item instanceof Element && item.dataset && item.dataset.dshAction);
    return node ? node.dataset.dshAction : "";
  }

  function onDown(event) {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onClick(event) {
    if (!active || pendingSend) return;
    const action = pickerAction(event);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      if (action === "send") send();
      else if (action === "up") climb();
      else if (action === "intent") cycleIntent();
      else if (action === "cancel") stop();
      return;
    }
    if (fromPicker(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const el = targetAt(event);
    if (!el) return;
    toggle(el);
  }

  function onKey(event) {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stop();
      return;
    }
    if (event.key === "Enter" && selected.length) {
      event.preventDefault();
      event.stopPropagation();
      send();
    }
  }

  function onLayout() {
    if (active && !pendingSend) redraw();
  }

  function stop() {
    active = false;
    selected = [];
    hovered = null;
    intent = "change";
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
    layer?.remove();
    bar?.remove();
    layer = null;
    bar = null;
    status = null;
    sendButton = null;
    intentButton = null;
  }

  function button(label, action, primary) {
    const el = document.createElement("button");
    el.type = "button";
    el.dataset.dshAction = action;
    el.dataset.dshPicker = "1";
    el.textContent = label;
    el.style.cssText = primary
      ? "font: 600 13px sans-serif; padding: 6px 12px; border-radius: 6px; border: 0; background: #e23d3d; color: #fff; cursor: pointer;"
      : "font: 13px sans-serif; padding: 6px 10px; border-radius: 6px; border: 1px solid #d0d0d0; background: #fff; color: #1f2328; cursor: pointer;";
    return el;
  }

  function start() {
    if (active) return;
    active = true;
    selected = [];
    layer = document.createElement("div");
    layer.setAttribute("data-dsh-picker", "1");
    bar = document.createElement("div");
    bar.setAttribute("data-dsh-picker", "1");
    bar.style.cssText = "position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); z-index: 2147483647; display: flex; gap: 8px; align-items: center; padding: 8px 10px; background: #fff; color: #1f2328; border: 1px solid #d0d0d0; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.16); font: 13px sans-serif; pointer-events: auto;";
    status = document.createElement("span");
    status.setAttribute("data-dsh-picker", "1");
    status.textContent = "点击添加，可多选";
    status.style.cssText = "max-width: 180px;";
    sendButton = button("发给 DSH", "send", true);
    sendButton.disabled = true;
    intentButton = button("改", "intent", false);
    bar.append(status, intentButton, sendButton, button("上一层", "up", false), button("取消", "cancel", false));
    document.documentElement.append(layer, bar);
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

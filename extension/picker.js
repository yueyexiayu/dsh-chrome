(() => {
  if (globalThis.__dshPickerInstalled) return;
  globalThis.__dshPickerInstalled = true;
  const MAX = 12;
  const STYLE_KEYS = ["display", "width", "height", "margin", "padding", "color", "border", "border-radius", "font-family", "font-size", "font-weight", "text-align"];
  let active = false, busy = false, panel, overlay, hover;
  let selected = [];
  // Only nodes allocated in this isolated world can operate the picker.
  const controls = new Map();
  let owned = new WeakSet();
  function node(tag, text) {
    const el = document.createElement(tag);
    el.setAttribute("data-dsh-picker", "1");
    if (text) el.textContent = text;
    owned.add(el);
    return el;
  }
  function ownEvent(event) { return event.composedPath().some(el => owned.has(el)); }
  function selectorOf(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts = [];
    for (let current = el; current && current !== document.documentElement && parts.length < 12; current = current.parentElement) {
      let part = current.tagName.toLowerCase();
      const siblings = current.parentElement && [...current.parentElement.children].filter(child => child.tagName === current.tagName);
      if (siblings?.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ").slice(0, 500);
  }
  function htmlOf(el) {
    const clone = el.cloneNode(true);
    for (const input of [clone, ...clone.querySelectorAll("input")]) {
      if (input.tagName?.toLowerCase() === "input" && String(input.getAttribute("type")).toLowerCase() === "password") {
        input.removeAttribute("value");
        input.value = "";
      }
    }
    return (clone.outerHTML || "").replace(/\s+/g, " ").trim().slice(0, 800);
  }
  function describe(el) {
    const rect = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 400);
    const style = getComputedStyle(el), styles = {};
    for (const key of STYLE_KEYS) styles[key] = style.getPropertyValue(key).slice(0, 160);
    const selector = selectorOf(el);
    return { tag, selector, location: selector, domPath: selector, role: el.getAttribute("role") || tag,
      name: (el.getAttribute("aria-label") || el.getAttribute("alt") || text).slice(0, 200), text, styles,
      bounds: `x=${Math.round(rect.left)}, y=${Math.round(rect.top)}, ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      html: htmlOf(el),
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
  }
  function button(text, action) {
    const el = node("button", text);
    el.type = "button";
    el.style.cssText = "padding:6px 10px;margin:3px;border:1px solid #777;border-radius:6px;color:#fff;background:#333;cursor:pointer;font:13px sans-serif";
    controls.set(el, action);
    return el;
  }
  function draw() {
    overlay?.remove();
    overlay = node("div");
    overlay.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646";
    [...selected, ...(hover && !selected.includes(hover) ? [hover] : [])].forEach((el, index) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      const box = node("div", index < selected.length ? String(index + 1) : "");
      box.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid #e65050;box-sizing:border-box;color:#fff;background:#e6505018;font:bold 14px sans-serif;pointer-events:none`;
      overlay.append(box);
    });
    document.documentElement.append(overlay);
  }
  function render(message) {
    panel?.remove(); controls.clear();
    panel = node("div");
    panel.style.cssText = "position:fixed;right:16px;top:16px;width:320px;padding:12px;background:#202124;color:#fff;border:1px solid #777;border-radius:10px;z-index:2147483647;font:13px/1.5 sans-serif;box-shadow:0 4px 24px #0008";
    panel.append(node("strong", "DSH · 选择页面元素"), node("p", message || "点选多个元素；用户要求将在独立扩展页中填写。Esc 退出。"));
    selected.forEach((el, index) => {
      const row = node("div", `${index + 1}. ${describe(el).name || el.tagName}`);
      row.append(button("移除", () => { selected.splice(index, 1); render(); draw(); }));
      panel.append(row);
    });
    panel.append(button(busy ? "正在准备…" : `编辑要求 (${selected.length})`, review), button("取消", stop));
    document.documentElement.append(panel);
  }
  async function review() {
    if (busy || !selected.length) return;
    const items = selected.filter(el => el.isConnected).map(describe);
    if (!items.length) { render("选中的元素已消失，请重新选择。"); return; }
    busy = true;
    panel.style.visibility = "hidden"; overlay.style.visibility = "hidden";
    // Wait for overlays to disappear from captureVisibleTab.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      const response = await chrome.runtime.sendMessage({ type: "dsh-pick-review", url: location.href, title: document.title, items,
        viewport: { width: window.innerWidth, height: window.innerHeight } });
      if (!response?.ok) throw new Error(response?.error || "未能打开要求编辑页");
      stop();
    } catch (error) { busy = false; render(error.message); draw(); }
  }
  function click(event) {
    if (!active || busy || !event.isTrusted) return;
    const control = event.composedPath().find(el => controls.has(el));
    if (control) { event.preventDefault(); event.stopPropagation(); controls.get(control)(); return; }
    if (ownEvent(event)) return;
    event.preventDefault(); event.stopPropagation();
    const el = document.elementsFromPoint(event.clientX, event.clientY).find(el => el instanceof Element && !owned.has(el));
    if (!el || selected.includes(el)) return;
    if (selected.length >= MAX) { render("最多选择 12 个元素。"); return; }
    selected.push(el); render(); draw();
  }
  function move(event) {
    if (!active || busy || !event.isTrusted || ownEvent(event)) return;
    hover = document.elementsFromPoint(event.clientX, event.clientY).find(el => el instanceof Element && !owned.has(el)); draw();
  }
  function key(event) { if (event.isTrusted && event.key === "Escape" && !busy) { event.preventDefault(); stop(); } }
  function redraw() { if (active && !busy) draw(); }
  function stop() {
    active = false; busy = false; panel?.remove(); overlay?.remove(); panel = overlay = hover = null;
    selected = []; controls.clear(); owned = new WeakSet();
    window.removeEventListener("click", click, true); window.removeEventListener("mousemove", move, true);
    window.removeEventListener("keydown", key, true); window.removeEventListener("scroll", redraw, true); window.removeEventListener("resize", redraw);
  }
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "dsh-pick-start") return;
    if (active) stop();
    else {
      active = true; render(); draw();
      window.addEventListener("click", click, true); window.addEventListener("mousemove", move, true);
      window.addEventListener("keydown", key, true); window.addEventListener("scroll", redraw, true); window.addEventListener("resize", redraw);
    }
    respond({ ok: true, active });
  });
})();

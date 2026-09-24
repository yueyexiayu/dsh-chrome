(() => {
  if (globalThis.__dshPickerInstalled) return;
  globalThis.__dshPickerInstalled = true;

  let active = false;
  let locked = null;
  let hovered = null;
  let box = null;
  let bar = null;
  let status = null;
  let sendButton = null;

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
    const raw = (el.innerText || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    return raw.slice(0, 400);
  }

  function place(el) {
    if (!box || !(el instanceof Element)) return;
    const rect = el.getBoundingClientRect();
    box.style.left = `${Math.max(0, rect.left)}px`;
    box.style.top = `${Math.max(0, rect.top)}px`;
    box.style.width = `${Math.max(0, rect.width)}px`;
    box.style.height = `${Math.max(0, rect.height)}px`;
  }

  function targetAt(event) {
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!(el instanceof Element) || el.hasAttribute("data-dsh-picker")) return null;
    return el;
  }

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  function climb() {
    const current = locked || hovered;
    const parent = current && current.parentElement;
    if (!parent || parent === document.documentElement || parent.hasAttribute("data-dsh-picker")) return;
    locked = parent;
    hovered = parent;
    place(parent);
    setStatus("已选上一层");
    if (sendButton) sendButton.disabled = false;
  }

  function payload(el) {
    const rect = el.getBoundingClientRect();
    const text = textOf(el);
    return {
      type: "dsh-pick",
      url: location.href,
      title: document.title || "",
      selector: selectorOf(el),
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") || el.getAttribute("alt") || text).slice(0, 200),
      text,
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  function finish() {
    stop();
  }

  function send() {
    const el = locked || hovered;
    if (!(el instanceof Element)) {
      setStatus("先点一个元素");
      return;
    }
    if (sendButton) sendButton.disabled = true;
    setStatus("正在发送…");
    chrome.runtime.sendMessage(payload(el), (res) => {
      const failed = chrome.runtime.lastError;
      if (failed || !res || !res.ok) {
        if (sendButton) sendButton.disabled = false;
        setStatus((res && res.error) || (failed && failed.message) || "没送出");
        return;
      }
      finish();
    });
  }

  function onMove(event) {
    if (!active || fromPicker(event) || locked) return;
    const el = targetAt(event);
    if (!el) return;
    hovered = el;
    place(el);
  }

  function onDown(event) {
    if (!active || fromPicker(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onClick(event) {
    if (!active || fromPicker(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const el = targetAt(event);
    if (!el) return;
    locked = el;
    hovered = el;
    place(el);
    setStatus("已锁定。可上一层，或发给 DSH");
    if (sendButton) sendButton.disabled = false;
  }

  function onKey(event) {
    if (!active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      stop();
      return;
    }
    if (event.key === "Enter" && locked) {
      event.preventDefault();
      event.stopPropagation();
      send();
    }
  }

  function stop() {
    active = false;
    locked = null;
    hovered = null;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mousedown", onDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("contextmenu", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    box?.remove();
    bar?.remove();
    box = null;
    bar = null;
    status = null;
    sendButton = null;
  }

  function button(label, onClickButton) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.style.cssText = "font: 13px sans-serif; padding: 6px 10px; border-radius: 6px; border: 1px solid #d0d0d0; background: #fff; color: #1f2328; cursor: pointer;";
    el.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClickButton();
    });
    return el;
  }

  function start() {
    if (active) return;
    active = true;
    box = document.createElement("div");
    box.setAttribute("data-dsh-picker", "1");
    box.style.cssText = "position: fixed; pointer-events: none; z-index: 2147483646; border: 2px solid #e23d3d; background: rgba(226,61,61,0.12); box-sizing: border-box;";
    bar = document.createElement("div");
    bar.setAttribute("data-dsh-picker", "1");
    bar.style.cssText = "position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647; display: flex; gap: 8px; align-items: center; padding: 8px 10px; background: #fff; color: #1f2328; border: 1px solid #d0d0d0; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.16); font: 13px sans-serif;";
    status = document.createElement("span");
    status.textContent = "悬停出框，点击锁定。Esc 取消";
    status.style.cssText = "max-width: 280px;";
    sendButton = button("发给 DSH", send);
    sendButton.disabled = true;
    bar.append(status, sendButton, button("上一层", climb), button("取消", stop));
    document.documentElement.append(box, bar);
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("contextmenu", onDown, true);
    document.addEventListener("keydown", onKey, true);
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

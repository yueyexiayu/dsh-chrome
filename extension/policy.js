export const HOST_NAME = "com.yueyexiayu.dsh.chrome";
export const GROUP_TITLE = "DSH";

export function groupTitle(owner) {
  const clean = String(owner || "default").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const tail = clean.slice(-6) || "default";
  return `${GROUP_TITLE} ${tail}`;
}

export function ignoreFocusMethod(method) {
  return method === "Page.bringToFront" || method === "Target.activateTarget";
}

export function tabCreateProperties(windowId, url) {
  return {
    url: url || "about:blank",
    active: false,
    windowId,
  };
}

export function windowCreateProperties(url) {
  return {
    url: url || "about:blank",
    focused: false,
    type: "normal",
  };
}

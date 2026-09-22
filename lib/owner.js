import { AsyncLocalStorage } from "node:async_hooks";
import { groupTitle } from "../extension/policy.js";

const owners = new AsyncLocalStorage();

export function contextKey(exec) {
  try {
    const session = exec && exec.agent && exec.agent.session;
    const raw = (session && session.id) || (exec && exec.agent && exec.agent.id);
    const id = raw == null ? "" : String(raw).trim();
    if (id && id !== "undefined") return id;
  } catch {
    // session id is optional
  }
  return "default";
}

export function withOwner(exec, fn) {
  return owners.run(contextKey(exec), fn);
}

export function currentOwner() {
  return owners.getStore() || "default";
}

export { groupTitle };

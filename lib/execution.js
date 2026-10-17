import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import pluginPackage from "../package.json" with { type: "json" };
import extensionManifest from "../extension/manifest.json" with { type: "json" };
import policyPackage from "@deepseek-ai/dsh-browser-use/package.json" with { type: "json" };
import {
  BrowserExecutionError,
  parseBrowserExecutionRequest,
  resolveBrowserExecution,
  validateBrowserExecution,
} from "@deepseek-ai/dsh-browser-use/execution";

export const browserExecutionVersions = Object.freeze({
  adapter: pluginPackage.version,
  extension: extensionManifest.version,
  policy: policyPackage.version,
  policySourceSha256: policyPackage.dshSourceArtifact?.sourceSha256,
});

const requests = new AsyncLocalStorage();
const capabilities = Object.freeze(["dom", "screenshot", "browser-extension", "authenticated-state"]);
const declaredEngine = Object.freeze({ kind: "external-browser", resolver: "chrome-extension-native-messaging", capabilities });

/** A direct JavaScript caller can make its operation's mode explicit; this is not a global policy. */
export function withBrowserExecution(request, fn) {
  const execution = resolveBrowserExecution(parseBrowserExecutionRequest(request));
  return requests.run(execution, fn);
}

export function currentBrowserExecution() {
  return requests.getStore();
}

/** Validate before connecting or creating any tab, then revalidate the actual bridge engine. */
export function extensionExecution(owner, request) {
  const selected = request ?? currentBrowserExecution();
  const execution = resolveBrowserExecution(parseBrowserExecutionRequest(selected ?? {
    scope: { sessionId: owner, taskId: randomUUID() },
    purpose: "interactive", mode: "headed", ownership: "borrowed-connection", capabilities,
  }));
  if (owner !== "default" && execution.scope.sessionId !== owner) {
    throw new BrowserExecutionError("BROWSER_OWNERSHIP_MISMATCH", execution, "Browser request differs from the actual conversation owner");
  }
  validateBrowserExecution(execution, { kind: "attach", engine: declaredEngine });
  return execution;
}

export function validateExtensionEngine(execution, metadata) {
  if (metadata?.kind !== "external-browser" || metadata.resolver !== declaredEngine.resolver
    || !Array.isArray(metadata.capabilities)) {
    throw Object.assign(new Error("Reload the DSH Chrome extension: its actual engine/capability handshake is unavailable"), { code: "CHROME_EXTENSION_UPDATE_REQUIRED" });
  }
  if (metadata.extensionVersion !== browserExecutionVersions.extension) {
    throw Object.assign(new Error(`The loaded Chrome adapter requires extension ${browserExecutionVersions.extension}; actual worker reports ${metadata.extensionVersion || "unavailable"}. Reload the matching extension before using its lifecycle contract.`), { code: "CHROME_EXTENSION_VERSION_MISMATCH" });
  }
  if (typeof metadata.browserVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(metadata.browserVersion)
    || metadata.versionSource !== "extension-worker-userAgentData.fullVersionList") {
    throw Object.assign(new Error("The Chrome extension could not report its actual full browser version; no browser identity is fabricated"), { code: "CHROME_BROWSER_IDENTITY_UNAVAILABLE" });
  }
  const engine = Object.freeze({ ...metadata,
    capabilities: Object.freeze(metadata.capabilities.filter(capability => capabilities.includes(capability))),
  });
  validateBrowserExecution(execution, { kind: "attach", engine });
  return engine;
}

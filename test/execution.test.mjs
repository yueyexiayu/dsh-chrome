import test from "node:test";
import assert from "node:assert/strict";
import { browserExecutionVersions, extensionExecution, validateExtensionEngine, withBrowserExecution, currentBrowserExecution } from "../lib/execution.js";
import { currentOwner, withOwner } from "../lib/owner.js";
import { engine } from "./fixtures/engine.mjs";
import pluginPackage from "../package.json" with { type: "json" };
import extensionManifest from "../extension/manifest.json" with { type: "json" };

function request(sessionId = "owner-a", changes = {}) {
  return { scope: { sessionId, taskId: "batch-a" }, purpose: "capture", mode: "headed", ownership: "borrowed-connection", capabilities: ["dom", "screenshot", "authenticated-state"], ...changes };
}

test("runtime versions come from installed adapter and local artifact manifests", () => {
  assert.equal(browserExecutionVersions.adapter, "0.2.3");
  assert.equal(browserExecutionVersions.extension, "0.2.4");
  assert.equal(browserExecutionVersions.policy, "0.2.1-alpha.4.browser-policy.1");
  assert.equal(browserExecutionVersions.policySourceSha256, "1a0d4cb9021826ef0cbba2f63a0fd07d4f295fd01418f5e61754c9b897a362a8");
});

test("T5 an old, missing or different worker version cannot satisfy the current lifecycle contract", () => {
  const spec = extensionExecution("owner-a", request());
  for (const extensionVersion of [undefined, "0.2.3", "0.2.5", "synthetic-worker"]) {
    assert.throws(() => validateExtensionEngine(spec, { ...engine, extensionVersion }), { code: "CHROME_EXTENSION_VERSION_MISMATCH" });
  }
  assert.equal(validateExtensionEngine(spec, engine).browserVersion, "1.2.3.4");
});

test("T5 loaded artifact versions are immutable snapshots, not live manifest lookups", () => {
  const adapter = pluginPackage.version, extension = extensionManifest.version;
  try {
    pluginPackage.version = "999.0.0";
    extensionManifest.version = "999.0.0";
    assert.equal(browserExecutionVersions.adapter, "0.2.3");
    assert.equal(browserExecutionVersions.extension, "0.2.4");
    assert.equal(Object.isFrozen(browserExecutionVersions), true);
    assert.equal(validateExtensionEngine(extensionExecution("owner-a"), engine).extensionVersion, "0.2.4");
  } finally {
    pluginPackage.version = adapter;
    extensionManifest.version = extension;
  }
});

test("extension execution is explicitly headed and borrowed, never filesystem-derived", () => {
  const spec = extensionExecution("owner-a");
  assert.equal(spec.mode, "headed");
  assert.equal(spec.ownership, "borrowed-connection");
  assert.equal(spec.scope.sessionId, "owner-a");
  assert.ok(Object.isFrozen(spec));
  assert.equal(validateExtensionEngine(spec, engine).browserVersion, "1.2.3.4");
});

test("malformed wire modes and missing or foreign actual owner are rejected", () => {
  assert.throws(() => extensionExecution("owner-a", request("owner-a", { mode: "silent" })), { code: "INVALID_BROWSER_EXECUTION_REQUEST" });
  assert.throws(() => extensionExecution("owner-a", request("owner-b")), { code: "BROWSER_OWNERSHIP_MISMATCH" });
  assert.throws(() => extensionExecution("owner-a", request("owner-a", { scope: {} })), { code: "INVALID_BROWSER_EXECUTION_REQUEST" });
});

test("headless, isolated context and download directory cannot borrow the extension", () => {
  assert.throws(() => extensionExecution("owner-a", request("owner-a", { mode: "headless", capabilities: ["dom"] })), { code: "BROWSER_MODE_MISMATCH" });
  for (const capability of ["isolated-context", "isolated-download-directory"]) {
    assert.throws(() => extensionExecution("owner-a", request("owner-a", { capabilities: [capability] })), { code: "UNSUPPORTED_BROWSER_CAPABILITY" });
  }
  assert.throws(() => extensionExecution("owner-a", request("owner-a", { ownership: "owned-process" })), { code: "BROWSER_OWNERSHIP_MISMATCH" });
});

test("actual bridge identity and capability metadata cannot be invented or silently reduced", () => {
  const spec = extensionExecution("owner-a", request());
  for (const metadata of [undefined, {}, { ...engine, kind: "chromium-headless-shell" }, { ...engine, resolver: "other" }]) {
    assert.throws(() => validateExtensionEngine(spec, metadata), { code: "CHROME_EXTENSION_UPDATE_REQUIRED" });
  }
  for (const browserVersion of [undefined, "123", "Chrome/1.2.3.4"]) {
    assert.throws(() => validateExtensionEngine(spec, { ...engine, browserVersion }), { code: "CHROME_BROWSER_IDENTITY_UNAVAILABLE" });
  }
  assert.throws(() => validateExtensionEngine(spec, { ...engine, capabilities: ["dom"] }), { code: "UNSUPPORTED_BROWSER_CAPABILITY" });
});

test("overlapping async requests retain their own execution and session identities", async () => {
  const run = (owner, mode) => withBrowserExecution(request(owner, { mode }), async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentOwner(), owner);
    assert.equal(currentBrowserExecution().mode, mode);
    return currentBrowserExecution().scope.sessionId;
  });
  assert.deepEqual(await Promise.all([run("owner-a", "headed"), run("owner-b", "headless")]), ["owner-a", "owner-b"]);
  assert.equal(currentBrowserExecution(), undefined);
  assert.equal(currentOwner(), "default");
});

test("host execution owner wins and cannot be overridden by a nested foreign request", async () => {
  await withOwner({ agent: { session: { id: "actual-session" } } }, async () => {
    await withBrowserExecution(request("foreign-session"), async () => {
      assert.equal(currentOwner(), "actual-session");
      assert.throws(() => extensionExecution(currentOwner()), { code: "BROWSER_OWNERSHIP_MISMATCH" });
    });
  });
});

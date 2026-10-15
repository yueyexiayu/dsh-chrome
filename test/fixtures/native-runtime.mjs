// Native/socket fixtures run only inside the genuine installed App's Node mode.
// Importing this module does not inspect or launch the App and creates no socket.
import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { peerAllowed } from "../../host/peer-identity.mjs";

export function requireInstalledRuntime() {
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, "1", "Native fixtures require ELECTRON_RUN_AS_NODE=1; ordinary Node is for the pure suite only");
  assert.equal(typeof process.versions.electron, "string", "Native fixtures require the genuine installed Electron runtime");
  assert.equal(process.type, undefined, "Native fixtures require Electron's Node mode, not a browser/renderer process");
  // process.execPath comes from this runtime, not argv0 or an environment override.
  const executable = realpathSync(process.execPath);
  assert.ok(peerAllowed(executable), "Native fixtures must use the real installed App executable, not a renamed/copied Node");
  return executable;
}

export function nativeFixtureEnv(home) {
  requireInstalledRuntime();
  const actual = realpathSync(home);
  const stat = statSync(actual);
  assert.ok(stat.isDirectory());
  const allowedParents = new Set([realpathSync(tmpdir()), realpathSync("/tmp")]);
  assert.ok(allowedParents.has(path.dirname(actual)), "Native fixtures require a private mkdtemp home directly under a system temporary directory");
  assert.match(path.basename(actual), /^(?:dsh-chrome-|chrome-)[A-Za-z0-9_-]*[A-Za-z0-9]{6}$/);
  assert.equal(stat.uid, process.getuid(), "Native fixture home must belong to the current user");
  assert.equal(stat.mode & 0o077, 0, "Native fixture home permissions must be private");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_HOME: actual };
  delete env.DSH_CHROME_ALLOW_NODE_PEER; // Never inherit the removed bypass.
  return env;
}

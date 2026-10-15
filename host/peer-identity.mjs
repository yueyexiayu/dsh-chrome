import fs from "node:fs";

// Only the installed DSH main executable may control the bridge. Callers must
// supply the OS-resolved socket peer path, never argv or a claimed client path.
export function peerAllowed(exe) {
  if (typeof exe !== "string" || /[\x00-\x1f\x7f]/.test(exe)) return false;
  const bundle = /^\/Applications\/DeepSeek Harness(?: ([^/]+))?\.app\/Contents\/MacOS\/DeepSeek Harness$/.exec(exe);
  if (!bundle) return false;
  // SemVer: stable releases, prereleases (including dated alpha builds), and
  // build metadata; numeric release/prerelease identifiers have no leading 0.
  const version = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (bundle[1] && !version.test(bundle[1])) return false;
  try {
    // Reject symlink aliases/escapes instead of trusting an install-looking
    // string that resolves to Node or to another application.
    return fs.realpathSync(exe) === exe;
  } catch {
    return false;
  }
}

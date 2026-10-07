import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const calls = new AsyncLocalStorage();

// Binary artifacts have no public writeBytes seam in the installed DSH FS API.
// Reuse its target resolver and session policy; publish only NEW files (O_EXCL).
// Never call writeText with binary data or quietly fall back to unrestricted IO.
export function withBrowserFiles(services, exec, fn) {
  return calls.run({ ...services, exec: exec || {} }, fn);
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function context() {
  const value = calls.getStore();
  if (!value?.fs || typeof value.fs.resolve !== "function") {
    throw fail("CHROME_FS_UNAVAILABLE", "Chrome file operations require the DSH filesystem service and tool execution context.");
  }
  value.exec.signal?.throwIfAborted();
  return value;
}

function sessionCwd(exec) {
  const session = exec.agent?.session;
  return session?.header?.cwd || session?.requestHeader?.()?.cwd;
}

function policyFor({ fs, sandboxPolicy, exec }) {
  if (sandboxPolicy) {
    const policy = sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {});
    if (!["read-only", "workspace-write", "danger-full-access"].includes(policy?.mode)) {
      throw fail("CHROME_FS_UNAVAILABLE", "DSH returned an unsupported filesystem policy.");
    }
    return policy;
  }
  if (fs.sandboxMode !== undefined) {
    throw fail("CHROME_FS_UNAVAILABLE", "The filesystem is sandboxed but its session policy service is unavailable.");
  }
  return { mode: "danger-full-access", workspaceRoot: sessionCwd(exec) };
}

async function resolvePath(requested, operation) {
  const call = context();
  const { fs, exec } = call;
  if (typeof requested !== "string" || !requested.trim()) throw new Error("File path must be a non-empty string.");
  const policy = policyFor(call);
  const target = await fs.resolve(requested, { cwd: policy.workspaceRoot || sessionCwd(exec), signal: exec.signal });
  const hostPath = fs.processPath?.(target);
  // Chrome is local. Do not interpret a remote-provider path in the host OS.
  if (typeof hostPath !== "string" || !path.isAbsolute(hostPath)
      || fs.processPathFromHostPath?.(hostPath) !== hostPath) {
    throw fail("CHROME_FS_UNAVAILABLE", "Chrome file operations require a host-backed DSH filesystem.");
  }
  if (operation === "write" && policy.mode !== "danger-full-access") {
    let allowed = false;
    if (policy.mode === "workspace-write") {
      // Same roots as the installed @deepseek-ai/dsh-sandbox writableRoots.
      if (!policy.workspaceRoot) throw fail("CHROME_FS_UNAVAILABLE", "Workspace-write policy has no workspace root.");
      for (const root of [policy.workspaceRoot, "/tmp", os.tmpdir()]) {
        const parent = await fs.resolve(root, { signal: exec.signal });
        if (await fs.contains(parent, target)) { allowed = true; break; }
      }
    }
    if (!allowed) throw fail("FS_SANDBOX_DENIED", `[sandbox: file access denied under ${policy.mode} mode]\n${target.displayPath}`);
  }
  const info = await fs.stat(target, exec.signal);
  if (operation === "read") {
    if (!info) throw fail("FS_NOT_FOUND", `File not found: ${target.displayPath}`);
    if (info.type !== "file") throw fail("FS_NOT_REGULAR_FILE", `Not a regular file: ${target.displayPath}`);
  } else if (info) {
    throw fail("FS_NOT_OBSERVED", `Chrome artifacts never overwrite existing files: ${target.displayPath}. Choose a new output path.`);
  }
  exec.signal?.throwIfAborted();
  return { ...call, hostPath, target };
}

export async function assertBrowserPath(requested, operation) {
  if (operation !== "read" && operation !== "write") throw new Error("File operation must be read or write.");
  return (await resolvePath(requested, operation)).hostPath;
}

export async function readBrowserFile(requested) {
  const { fs, target, exec } = await resolvePath(requested, "read");
  if (typeof fs.readBytes !== "function") throw fail("CHROME_FS_UNAVAILABLE", "DSH filesystem cannot read binary files.");
  return Buffer.from(await fs.readBytes(target, exec.signal, 48 * 1024 * 1024));
}

export async function writeBrowserFile(requested, bytes) {
  const first = await resolvePath(requested, "write");
  const directory = path.dirname(first.hostPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Re-resolve after directory creation; use the checked identity, not the
  // original spelling. A swapped parent symlink must not change the target.
  const checked = await resolvePath(requested, "write");
  if (checked.hostPath !== first.hostPath || await realpath(directory) !== directory) {
    throw fail("FS_STALE_VERSION", "Chrome output path changed while preparing the write; retry with a stable path.");
  }
  const handle = await open(checked.hostPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes, { signal: checked.exec.signal });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return checked.hostPath;
}

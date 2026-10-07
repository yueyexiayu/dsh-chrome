import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, stat, readFile, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withBrowserFiles, assertBrowserPath, readBrowserFile, writeBrowserFile } from "../lib/files.js";

async function fixture(t, mode = "workspace-write") {
  const root = await mkdtemp(path.join(os.tmpdir(), "chrome-files-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const resolutions = [];
  // Provider contract fixture uses real canonical paths, stat, and symlinks.
  async function canonical(file) {
    try { return await realpath(file); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return path.join(await canonical(path.dirname(file)), path.basename(file));
    }
  }
  const fs = {
    sandboxMode: "workspace-write",
    async resolve(file, options = {}) {
      const displayPath = path.resolve(options.cwd || workspace, file);
      return { targetKey: await canonical(displayPath), displayPath };
    },
    readBytes(target, signal) { return readFile(target.targetKey, { signal }); },
    processPath(target) { return target.targetKey; },
    processPathFromHostPath(file) { return file; },
    contains(parent, child) {
      const rel = path.relative(parent.targetKey, child.targetKey);
      return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
    },
    async stat(target) {
      try {
        const info = await stat(target.targetKey);
        return { type: info.isFile() ? "file" : "directory", size: info.size };
      } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    },
  };
  const session = { id: "test-session", header: { cwd: workspace } };
  const exec = { agent: { session }, signal: new AbortController().signal };
  const sandboxPolicy = { resolve(options) { resolutions.push(options); return { mode, workspaceRoot: workspace }; } };
  return { root, workspace, fs, exec, session, resolutions, run: fn => withBrowserFiles({ fs, sandboxPolicy }, exec, fn) };
}

test("Chrome binary files use calling session policy and private create-only output", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255]);
  const output = await f.run(() => writeBrowserFile("shots/a.png", bytes));
  assert.equal(output, path.join(await realpath(f.workspace), "shots/a.png"));
  assert.deepEqual(await readFile(output), bytes);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(output))).mode & 0o777, 0o700);
  assert.ok(f.resolutions.every(value => value.session === f.session));
  await assert.rejects(f.run(() => writeBrowserFile("shots/a.png", Buffer.from("replace"))), { code: "FS_NOT_OBSERVED" });
  assert.deepEqual(await readFile(output), bytes);
});

test("read-only forbids binary artifacts without creating directories", async t => {
  const f = await fixture(t, "read-only");
  await assert.rejects(f.run(() => writeBrowserFile("new/a.png", Buffer.from("a"))), /\[sandbox: file access denied under read-only mode\]/);
  await assert.rejects(stat(path.join(f.workspace, "new")), { code: "ENOENT" });
});

test("workspace-write denies outside roots and follows symlink targets before authorization", async t => {
  const f = await fixture(t);
  // Home is outside the fixture workspace and the officially writable temp roots.
  const outside = path.join(os.homedir(), `chrome-denied-${path.basename(f.root)}.png`);
  await assert.rejects(f.run(() => assertBrowserPath(outside, "write")), { code: "FS_SANDBOX_DENIED" });
  await symlink(os.homedir(), path.join(f.workspace, "escape"));
  await assert.rejects(f.run(() => writeBrowserFile(`escape/${path.basename(outside)}`, Buffer.from("no"))), { code: "FS_SANDBOX_DENIED" });
  await assert.rejects(stat(outside), { code: "ENOENT" });
});

test("temporary roots remain writable exactly as the DSH workspace policy permits", async t => {
  const f = await fixture(t);
  const dest = path.join(f.root, "outside-workspace.png");
  await f.run(() => writeBrowserFile(dest, Buffer.from("temp")));
  assert.equal(await readFile(dest, "utf8"), "temp");
});

test("upload path authorization requires a host-backed regular file; reads work in read-only", async t => {
  const f = await fixture(t, "read-only");
  const source = path.join(f.workspace, "input.bin");
  await writeFile(source, Buffer.from([0, 1, 255]));
  assert.equal(await f.run(() => assertBrowserPath(source, "read")), await realpath(source));
  assert.deepEqual(await f.run(() => readBrowserFile(source)), Buffer.from([0, 1, 255]));
  await assert.rejects(f.run(() => assertBrowserPath(f.workspace, "read")), { code: "FS_NOT_REGULAR_FILE" });
  await assert.rejects(f.run(() => assertBrowserPath("missing", "read")), { code: "FS_NOT_FOUND" });
  f.fs.processPathFromHostPath = () => undefined;
  await assert.rejects(f.run(() => assertBrowserPath(source, "read")), { code: "CHROME_FS_UNAVAILABLE" });
});

test("binary reads delegate limits, cancellation and provider errors to DSH fs", async t => {
  const f = await fixture(t, "read-only");
  const source = path.join(f.workspace, "provider.png");
  await writeFile(source, "fixture");
  const controller = new AbortController();
  f.exec.signal = controller.signal;
  const failure = new Error("provider read denied");
  f.fs.readBytes = async (target, signal, maxBytes) => {
    assert.equal(target.targetKey, await realpath(source));
    assert.equal(signal, controller.signal);
    assert.equal(maxBytes, 48 * 1024 * 1024);
    throw failure;
  };
  await assert.rejects(f.run(() => readBrowserFile(source)), error => error === failure);
});

test("missing policy, missing tool scope and abort fail closed", async t => {
  const f = await fixture(t);
  await assert.rejects(writeBrowserFile(path.join(f.root, "no-scope"), Buffer.from("no")), { code: "CHROME_FS_UNAVAILABLE" });
  await assert.rejects(withBrowserFiles({ fs: f.fs }, f.exec, () => writeBrowserFile("no-policy", Buffer.from("no"))), { code: "CHROME_FS_UNAVAILABLE" });
  const controller = new AbortController(); controller.abort();
  f.exec.signal = controller.signal;
  await assert.rejects(f.run(() => writeBrowserFile("aborted", Buffer.from("no"))), { name: "AbortError" });
});

test("concurrent writes cannot clobber one another", async t => {
  const f = await fixture(t, "danger-full-access");
  const outcomes = await Promise.allSettled(["first", "second"].map(value => f.run(() => writeBrowserFile("race.png", Buffer.from(value)))));
  assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
  const stored = await readFile(path.join(f.workspace, "race.png"), "utf8");
  assert.ok(["first", "second"].includes(stored));
});

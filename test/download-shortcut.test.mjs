import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import * as page from "../lib/page.js";

const source = readFileSync(new URL("../lib/browser.js", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const actions = [{ action: "navigate", url: "https://example.test/" }];
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-shortcut-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, "cache", "chrome-shortcuts.json") };
}
function harness(root, overrides = {}) {
  const current = { owner: "conversation-one", cdp: { send: async () => ({ items: [] }) } };
  const context = { ...page, ...fs, path, os, randomUUID, Buffer, URL, console, setTimeout, clearTimeout,
    process: { env: { DSH_HOME: root } }, currentOwner: () => current.owner, current, ...overrides };
  vm.runInNewContext(source + '\nensure=async()=>current; globalThis.api={shortcut,downloads};', context);
  return { ...context.api, current };
}
async function seed(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("downloads returns empty only after a successful owner-scoped bridge query", async t => {
  const f = await fixture(t); const h = harness(f.root); const calls = [];
  h.current.cdp.send = async (...args) => { calls.push(args); return { items: [] }; };
  assert.match(await h.downloads(), /\(none\)/);
  assert.equal(calls[0][0], "Browser.getDownloadItems");
  assert.equal(calls[0][1].dshOwner, "conversation-one");
  h.current.cdp.send = async () => ({ items: [{ filename: "fresh", state: "complete" }] });
  assert.match(await h.downloads(), /fresh/);
});
test("downloads propagates bridge and cancellation errors without stale/empty success", async t => {
  const f = await fixture(t); const h = harness(f.root);
  for (const message of ["bridge disconnected", "cancelled", "Browser.getDownloadItems timed out"]) {
    h.current.cdp.send = async () => { throw new Error(message); };
    await assert.rejects(h.downloads(), new RegExp(message.replaceAll(".", "\\.")));
  }
});
test("downloads preserves explicit unsupported capability errors, never an empty success", async t => {
  const f = await fixture(t); const h = harness(f.root);
  h.current.cdp.send = async () => { throw Object.assign(new Error("owner inventory cannot be proved"), { code: "UNSUPPORTED_BROWSER_CAPABILITY" }); };
  await assert.rejects(h.downloads(), { code: "UNSUPPORTED_BROWSER_CAPABILITY" });
});
test("downloads rejects malformed bridge response", async t => {
  const f = await fixture(t); const h = harness(f.root);
  for (const response of [null, {}, { items: null }, { items: {} }]) {
    h.current.cdp.send = async () => response;
    await assert.rejects(h.downloads(), /invalid.*download/i);
  }
});
test("missing shortcut file is an empty store and first save is private", async t => {
  const f = await fixture(t); const h = harness(f.root);
  assert.equal(await h.shortcut({ action: "list" }), "(none)");
  assert.equal(await h.shortcut({ action: "save", name: "first", actions }), "saved shortcut first");
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), { first: actions });
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(f.file))).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ["chrome-shortcuts.json"]);
});
test("invalid JSON and invalid store shapes are visible and never overwritten", async t => {
  const f = await fixture(t); const h = harness(f.root);
  for (const value of ["{broken", "null", "[]", "3", '{"bad":3}', '{"bad":[]}', '{"bad":[{"action":"nope"}]}', '{"bad":[{"action":"navigate"}]}']) {
    await seed(f.file, value);
    for (const action of ["list", "save", "run"]) {
      await assert.rejects(h.shortcut({ action, name: "replacement", actions }));
      assert.equal(await fs.readFile(f.file, "utf8"), value);
    }
  }
});
test("non-ENOENT shortcut read errors propagate and forbid writes", async t => {
  const f = await fixture(t); let writes = 0;
  for (const code of ["EACCES", "EIO", "ENOTDIR"]) {
    const h = harness(f.root, { readFile: async () => { throw Object.assign(new Error(`read ${code}`), { code }); },
      writeFile: async () => { writes++; }, open: async () => { writes++; throw new Error("unexpected write"); } });
    for (const action of ["list", "save", "run"]) await assert.rejects(h.shortcut({ action, name: "new", actions }), new RegExp(code));
  }
  assert.equal(writes, 0);
});
test("shortcut names are own keys, including prototype-like names", async t => {
  const f = await fixture(t); const h = harness(f.root);
  for (const name of ["toString", "constructor", "__proto__"]) {
    await assert.rejects(h.shortcut({ action: "run", name }), /shortcut not found/);
    await h.shortcut({ action: "save", name, actions });
  }
  const stored = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["__proto__", "constructor", "toString"].sort());
  assert.deepEqual(stored.__proto__, actions);
});
test("invalid action payloads fail before persistence", async t => {
  const f = await fixture(t); const h = harness(f.root);
  for (const steps of [[{ action: "navigate", url: "file:///tmp/no" }], [{ action: "click" }], [{ action: "type", ref: 0 }], [{ action: "press", key: "bogus" }], [{ action: "fill", fields: [] }], [{ action: "hover" }], [{ action: "wait", ms: -1 }], [{ action: "scroll", direction: "bogus" }]]) {
    await assert.rejects(h.shortcut({ action: "save", name: "invalid", actions: steps }));
  }
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});
test("concurrent shortcut saves preserve every distinct name and replacements", async t => {
  const f = await fixture(t); const h = harness(f.root);
  await Promise.all(Array.from({ length: 20 }, (_, i) => h.shortcut({ action: "save", name: `shortcut-${i}`, actions })));
  const stored = JSON.parse(await fs.readFile(f.file, "utf8"));
  assert.equal(Object.keys(stored).length, 20);
  await h.shortcut({ action: "save", name: "shortcut-0", actions: [{ action: "wait", ms: 1 }] });
  assert.equal(Object.keys(JSON.parse(await fs.readFile(f.file, "utf8"))).length, 20);
  assert.match(await h.shortcut({ action: "list" }), /shortcut-19 \(1 steps\)/);
});
test("cross-process saves preserve every successful write", async t => {
  const f = await fixture(t);
  const module = new URL("../lib/browser.js", import.meta.url).href;
  await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((resolve, reject) => {
    const code = `import {shortcut} from ${JSON.stringify(module)}; await shortcut({action:'save',name:'process-${i}',actions:${JSON.stringify(actions)}});`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, DSH_HOME: f.root }, stdio: ["ignore", "ignore", "pipe"] });
    let errors = ""; child.stderr.on("data", data => { errors += data; });
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error(errors || `exit ${code}`)));
  })));
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(f.file, "utf8"))).sort(), Array.from({ length: 6 }, (_, i) => `process-${i}`));
});
test("write, sync and rename failures preserve the original and clean owned temporary files", async t => {
  const f = await fixture(t); await seed(f.file, { original: actions });
  const before = await fs.readFile(f.file, "utf8");
  for (const phase of ["write", "sync", "rename"]) {
    const h = harness(f.root, {
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (!String(args[0]).endsWith(".tmp")) return handle;
        return { writeFile: phase === "write" ? async () => { throw new Error("write EIO"); } : (...v) => handle.writeFile(...v),
          sync: phase === "sync" ? async () => { throw new Error("sync EIO"); } : () => handle.sync(), close: () => handle.close() };
      }, rename: phase === "rename" ? async () => { throw new Error("rename EIO"); } : fs.rename,
    });
    await assert.rejects(h.shortcut({ action: "save", name: "new", actions }), /EIO/);
    assert.equal(await fs.readFile(f.file, "utf8"), before);
    assert.deepEqual(await fs.readdir(path.dirname(f.file)), ["chrome-shortcuts.json"]);
  }
});
test("valid stored shortcut executes with the caller signal, without a real browser", async t => {
  const f = await fixture(t); await seed(f.file, { route: actions });
  const h = harness(f.root);
  // Replace only the action endpoint, not persistence or validation.
  const context = { ...page, ...fs, path, os, randomUUID, Buffer, URL, console, setTimeout, clearTimeout,
    process: { env: { DSH_HOME: f.root } }, seen: [], };
  vm.runInNewContext(source + '\nnavigate=async(url,options)=>{seen.push({url,options});return "fixture snapshot"};globalThis.api={shortcut};', context);
  const signal = new AbortController().signal;
  assert.match(await context.api.shortcut({ action: "run", name: "route", signal }), /step 1 navigate:\nfixture snapshot/);
  assert.equal(context.seen.length, 1);
  assert.equal(context.seen[0].url, "https://example.test/");
  assert.equal(context.seen[0].options.signal, signal);
  assert.match(await h.shortcut({ action: "list" }), /route \(1 steps\)/);
});
test("save revalidates the store under its acquired lock", async t => {
  const f = await fixture(t); await seed(f.file, { original: actions });
  const h = harness(f.root, { open: async (...args) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith(".lock")) await fs.writeFile(f.file, "{changed-to-corrupt");
    return handle;
  } });
  await assert.rejects(h.shortcut({ action: "save", name: "new", actions }), /invalid shortcut store JSON/);
  assert.equal(await fs.readFile(f.file, "utf8"), "{changed-to-corrupt");
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), ["chrome-shortcuts.json"]);
});
test("atomic replacement keeps the complete old store visible until rename", async t => {
  const f = await fixture(t); await seed(f.file, { original: actions });
  let renamed = false;
  const h = harness(f.root, { rename: async (temp, file) => {
    assert.equal(file, f.file);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { original: actions });
    assert.deepEqual(JSON.parse(await fs.readFile(temp, "utf8")), { original: actions, new: actions });
    renamed = true;
    return fs.rename(temp, file);
  } });
  await h.shortcut({ action: "save", name: "new", actions });
  assert.equal(renamed, true);
});
test("lock acquisition failures are visible and do not overwrite existing data", async t => {
  const f = await fixture(t); await seed(f.file, { original: actions });
  const before = await fs.readFile(f.file, "utf8");
  const denied = harness(f.root, { open: async () => { throw Object.assign(new Error("lock EACCES"), { code: "EACCES" }); } });
  await assert.rejects(denied.shortcut({ action: "save", name: "new", actions }), /EACCES/);
  await fs.writeFile(`${f.file}.lock`, "another writer");
  let time = 0;
  const busy = harness(f.root, { Date: { now: () => (time += 5001) } });
  await assert.rejects(busy.shortcut({ action: "save", name: "new", actions }), /shortcut store is busy/);
  assert.equal(await fs.readFile(`${f.file}.lock`, "utf8"), "another writer");
  assert.equal(await fs.readFile(f.file, "utf8"), before);
});
test("an occupied lock is never stolen and cancelled saves do not mutate the store", async t => {
  const f = await fixture(t); await seed(f.file, { original: actions });
  const lock = `${f.file}.lock`; await fs.writeFile(lock, "other writer");
  const controller = new AbortController(); const h = harness(f.root);
  const saving = h.shortcut({ action: "save", name: "new", actions, signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(saving, /cancelled/);
  assert.equal(await fs.readFile(lock, "utf8"), "other writer");
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), { original: actions });
});

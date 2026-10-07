import assert from "node:assert/strict";
import { JPEG } from "./fixtures/jpeg.mjs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as marks from "../lib/marks.js";

const consumer = "recovery-consumer";
const delivery = { sessionId: "original-session", attachmentIds: ["attachment-one"] };
let restart = 0;

function fixture(t) {
  const home = fs.mkdtempSync(path.join(tmpdir(), "dsh-chrome-recovery-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mark = marks.saveMark(home, { url: "https://fixture.invalid/", image: JPEG });
  const file = path.join(marks.marksDir(home), fs.readdirSync(marks.marksDir(home))[0]);
  return { home, mark, file, lease: marks.peekMark(home, consumer) };
}

async function restartedHost() {
  return import(`../lib/marks.js?recovery-host=${++restart}`);
}

test("prepared delivery survives a Host restart with a fresh lease and can be acknowledged", async t => {
  const { home, mark, file, lease } = fixture(t);
  assert.equal(marks.prepareMark(home, mark.id, consumer, lease.claim, delivery), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).delivery, delivery);
  const fresh = await restartedHost();
  const recovered = fresh.peekMark(home, "new-host-consumer");
  assert.equal(recovered.id, mark.id);
  assert.deepEqual(recovered.delivery, delivery);
  assert.notEqual(recovered.claim, lease.claim);
  assert.equal(fresh.ackMark(home, mark.id, "new-host-consumer", recovered.claim), true);
  assert.equal(fresh.peekMark(home, "new-host-consumer"), null);
  assert.equal(fs.existsSync(file), false);
});

test("preexisting queues have no delivery metadata and are still consumable", t => {
  const { home, mark, lease } = fixture(t);
  assert.equal("delivery" in lease, false);
  assert.equal(marks.ackMark(home, mark.id, consumer, lease.claim), true);
  assert.equal(marks.peekMark(home, consumer), null);
});

test("invalid delivery and foreign claims cannot change the queued record", t => {
  const { home, mark, file, lease } = fixture(t);
  const original = fs.readFileSync(file, "utf8");
  for (const value of [null, {}, { ...delivery, sessionId: " " }, { ...delivery, sessionId: "x".repeat(257) },
    { ...delivery, attachmentIds: [] }, { ...delivery, attachmentIds: [""] },
    { ...delivery, attachmentIds: ["x".repeat(257)] },
    { ...delivery, attachmentIds: Array.from({ length: 13 }, (_, index) => String(index)) },
    { ...delivery, attachmentIds: ["duplicate", "duplicate"] }]) {
    assert.throws(() => marks.prepareMark(home, mark.id, consumer, lease.claim, value), /交付记录无效/);
  }
  assert.throws(() => marks.prepareMark(home, mark.id, "other-consumer", lease.claim, delivery), /其他输入框/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("ordinary prepare rejects existing delivery instead of overwriting its draft identity", t => {
  const { home, mark, file, lease } = fixture(t);
  marks.prepareMark(home, mark.id, consumer, lease.claim, delivery);
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => marks.prepareMark(home, mark.id, consumer, lease.claim,
    { sessionId: "other-session", attachmentIds: ["new-attachment"] }), /已有交付记录/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("retry atomically replaces attachment identities only within the recorded session", async t => {
  const { home, mark, file, lease } = fixture(t);
  assert.throws(() => marks.prepareMark(home, mark.id, consumer, lease.claim, delivery, true), /没有待恢复/);
  marks.prepareMark(home, mark.id, consumer, lease.claim, delivery);
  assert.throws(() => marks.prepareMark(home, mark.id, consumer, lease.claim,
    { sessionId: "other-session", attachmentIds: ["replacement"] }, true), /原会话/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).delivery, delivery);
  const replacement = { sessionId: delivery.sessionId, attachmentIds: ["replacement"] };
  marks.prepareMark(home, mark.id, consumer, lease.claim, replacement, true);
  const fresh = await restartedHost();
  assert.deepEqual(fresh.peekMark(home, "new-host-consumer").delivery,
    { ...replacement, replacedAttachmentIds: delivery.attachmentIds });
});

test("two recovery retries retain all replaced attachment identities across a Host restart", async t => {
  const { home, mark, lease } = fixture(t);
  marks.prepareMark(home, mark.id, consumer, lease.claim, delivery);
  marks.prepareMark(home, mark.id, consumer, lease.claim,
    { sessionId: delivery.sessionId, attachmentIds: ["second-attachment"] }, true);
  marks.prepareMark(home, mark.id, consumer, lease.claim,
    { sessionId: delivery.sessionId, attachmentIds: ["third-attachment"] }, true);
  const fresh = await restartedHost();
  assert.deepEqual(fresh.peekMark(home, "new-host-consumer").delivery, {
    sessionId: delivery.sessionId, attachmentIds: ["third-attachment"],
    replacedAttachmentIds: ["second-attachment", "attachment-one"],
  });
});

test("retry excludes reused attachments and rejects excessive replacement history without changing the record", t => {
  const { home, mark, file, lease } = fixture(t);
  const originals = Array.from({ length: 12 }, (_, index) => `original-${index}`);
  marks.prepareMark(home, mark.id, consumer, lease.claim,
    { sessionId: delivery.sessionId, attachmentIds: originals });
  marks.prepareMark(home, mark.id, consumer, lease.claim,
    { sessionId: delivery.sessionId, attachmentIds: [originals[0], "replacement"] }, true);
  assert.deepEqual(marks.peekMark(home, consumer).delivery.replacedAttachmentIds, originals.slice(1));
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => marks.prepareMark(home, mark.id, consumer, lease.claim,
    { sessionId: delivery.sessionId, attachmentIds: ["newest"] }, true), /恢复附件记录已满/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("persisted replacement identities must be unique, bounded and distinct from current attachments", t => {
  const { home, mark, file, lease } = fixture(t);
  const original = fs.readFileSync(file, "utf8");
  for (const replacedAttachmentIds of [[""], ["x".repeat(257)], ["duplicate", "duplicate"],
    delivery.attachmentIds, Array.from({ length: 13 }, (_, index) => String(index)), "not-an-array"]) {
    assert.throws(() => marks.prepareMark(home, mark.id, consumer, lease.claim,
      { ...delivery, replacedAttachmentIds }), /交付记录无效/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("release durably clears prepared delivery after rollback while keeping the mark", async t => {
  const { home, mark, lease } = fixture(t);
  marks.prepareMark(home, mark.id, consumer, lease.claim, delivery);
  assert.throws(() => marks.releaseMark(home, mark.id, "other-consumer", lease.claim), /其他输入框/);
  assert.equal(marks.releaseMark(home, mark.id, consumer, lease.claim), true);
  const fresh = await restartedHost();
  const next = fresh.peekMark(home, "new-host-consumer");
  assert.equal(next.id, mark.id);
  assert.equal("delivery" in next, false);
});

test("a restarted Host requires a renewed claim before releasing a persisted delivery", async t => {
  const { home, mark, lease } = fixture(t);
  marks.prepareMark(home, mark.id, consumer, lease.claim, delivery);
  const fresh = await restartedHost();
  assert.throws(() => fresh.releaseMark(home, mark.id, consumer, lease.claim), /其他输入框/);
  const next = fresh.peekMark(home, consumer);
  assert.deepEqual(next.delivery, delivery);
  fresh.releaseMark(home, mark.id, consumer, next.claim);
  assert.equal("delivery" in fresh.peekMark(home, consumer), false);
});

test("prepare write failure is visible, preserves the old mark and cleans the temporary file", t => {
  const { home, mark, file, lease } = fixture(t);
  const original = fs.readFileSync(file, "utf8");
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    if (typeof target === "number") throw Object.assign(new Error("fixture disk write failed"), { code: "ENOSPC" });
    return originalWrite(target, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => marks.prepareMark(home, mark.id, consumer, lease.claim, delivery), /disk write failed/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(marks.marksDir(home)), [path.basename(file)]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(marks.prepareMark(home, mark.id, consumer, lease.claim, delivery), true);
});

test("failed release persistence keeps the delivery and its claim available for a safe retry", t => {
  const { home, mark, file, lease } = fixture(t);
  marks.prepareMark(home, mark.id, consumer, lease.claim, delivery);
  const originalRename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to === file) throw new Error("fixture rename failed");
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => marks.releaseMark(home, mark.id, consumer, lease.claim), /rename failed/);
    assert.deepEqual(marks.peekMark(home, consumer).delivery, delivery);
    assert.equal(marks.peekMark(home, consumer).claim, lease.claim);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(marks.releaseMark(home, mark.id, consumer, lease.claim), true);
});

test("prepare and acknowledgment synchronize the file and queue directory before returning", t => {
  const { home, mark, lease } = fixture(t);
  const syncs = [];
  const originalSync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", fd => {
    syncs.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    return originalSync(fd);
  });
  syncBuiltinESMExports();
  try {
    marks.prepareMark(home, mark.id, consumer, lease.claim, delivery);
    assert.deepEqual(syncs, ["file", "directory"]);
    marks.ackMark(home, mark.id, consumer, lease.claim);
    assert.deepEqual(syncs, ["file", "directory", "directory"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("corrupt persisted delivery is a visible queue error and is never discarded", t => {
  const { home, file } = fixture(t);
  const mark = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...mark, delivery: { sessionId: "", attachmentIds: [] } }));
  assert.throws(() => marks.peekMark(home, consumer), /交付记录无效/);
  assert.equal(fs.existsSync(file), true);
});

test("acknowledgment retries flush the directory after a failed unlink confirmation", t => {
  const { home, mark, file, lease } = fixture(t);
  const originalSync = fs.fsyncSync;
  let failed = false;
  t.mock.method(fs, "fsyncSync", fd => {
    if (!failed && fs.fstatSync(fd).isDirectory()) { failed = true; throw new Error("fixture directory sync failed"); }
    return originalSync(fd);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => marks.ackMark(home, mark.id, consumer, lease.claim), /directory sync failed/);
    assert.equal(fs.existsSync(file), false);
    assert.equal(marks.ackMark(home, mark.id, consumer, lease.claim), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

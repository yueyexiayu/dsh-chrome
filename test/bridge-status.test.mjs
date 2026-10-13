import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getEventListeners } from 'node:events';

const source = readFileSync(new URL('../lib/browser.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
function harness(options = {}) {
  const links = [], calls = []; let owner = 'owner-A', attempts = 0;
  class Link {
    constructor() { this.readyState = 1; this.handlers = { message: new Set(), close: new Set() }; }
    addEventListener(name, fn) { this.handlers[name]?.add(fn); }
    send(text) {
      const message = JSON.parse(text); calls.push(message);
      if (options.sendError) throw new Error('transport send failed');
      if (options.stall) return;
      queueMicrotask(() => {
        const result = message.method === 'DSH.hello'
          ? { ok: true, protocolVersion: options.protocol ?? 2 } : {};
        for (const fn of this.handlers.message) fn({ data: JSON.stringify({ id: message.id, result }) });
      });
    }
    close() { this.readyState = 3; for (const fn of this.handlers.close) fn(); }
  }
  const ctx = {
    currentOwner: () => owner, groupTitle: value => 'DSH ' + value,
    setTimeout: (fn, ms) => setTimeout(fn, options.fastTimers ? 5 : ms), clearTimeout,
    AbortController, AbortSignal, WebSocket: { OPEN: 1, CONNECTING: 0 },
    randomUUID: () => 'fixture',
    connectBridge: async signal => {
      attempts++; options.signals?.push(signal);
      if (options.connectError) throw new Error('fixture handshake denied');
      if (options.beforeConnect) await options.beforeConnect();
      const link = new Link(); links.push(link); return link;
    },
  };
  vm.runInNewContext(source + '\nglobalThis.api = { Cdp, browsers, ensure, openCaptureSession, exclusive, onBrowserEvent, pages, setBridge: value => { bridge = value; }, getBridge: () => bridge };', ctx);
  return { api: ctx.api, links, calls, attempts: () => attempts, owner: value => { owner = value; } };
}

test('idle status performs a real hello without creating or discovering tabs', async () => {
  const h = harness(); const text = await h.api.browsers('list');
  assert.equal(h.attempts(), 1); assert.match(text, /bridge: connected/);
  assert.match(text, /conversations: 0/);
  assert.deepEqual(h.calls.map(call => call.method), ['DSH.hello']);
  assert.equal(h.api.pages.size, 0);
});

test('repeated and concurrent status calls reuse one connection and preserve healthy pages', async () => {
  const h = harness(); await Promise.all([h.api.browsers('list'), h.api.browsers('list')]);
  const cdp = h.api.getBridge(); h.api.pages.set('owner-A', { cdp, sessionId: 'tab-A' });
  await h.api.browsers('list');
  assert.equal(h.attempts(), 1); assert.equal(h.api.pages.get('owner-A').cdp, cdp);
  assert.ok(h.calls.every(call => call.method === 'DSH.hello'));
});

test('connection failure rejects instead of reporting a cached disconnected or connected result', async () => {
  const h = harness({ connectError: true });
  await assert.rejects(h.api.browsers('list'), /fixture handshake denied/);
});

test('queued cancellation never connects and active cancellation reaches the transport probe', async () => {
  const cancelled = new AbortController(); cancelled.abort(); const h = harness();
  await assert.rejects(h.api.browsers('list', undefined, cancelled.signal), /cancelled/);
  assert.equal(h.attempts(), 0);
  const signals = [], running = harness({ stall: true, signals }); const abort = new AbortController();
  const result = running.api.browsers('list', undefined, abort.signal);
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(result, /cancelled/); assert.equal(signals[0], abort.signal);
});

test('health probe protocol failure is explicit and discards the invalid connection', async () => {
  const h = harness({ protocol: 1 });
  await assert.rejects(h.api.browsers('list'), /protocol 2/);
  assert.equal(h.api.getBridge(), null); assert.equal(h.links[0].readyState, 3);
});

test('health probe timeout and transport send failure stay visible and release pending requests', async () => {
  for (const options of [{ stall: true, fastTimers: true }, { sendError: true }]) {
    const h = harness(options);
    await assert.rejects(h.api.browsers('list'), /timed out|transport send failed/);
    assert.equal(h.api.getBridge(), null); assert.equal(h.links[0].readyState, 3);
  }
});

test('disconnect invalidates every owner cache without closing real tabs', async () => {
  const h = harness(); await h.api.browsers('list'); const old = h.api.getBridge();
  h.api.pages.set('owner-A', { cdp: old, sessionId: 'tab-A' });
  h.api.pages.set('owner-B', { cdp: old, sessionId: 'tab-B' });
  h.links[0].close(); assert.equal(h.api.pages.size, 0);
  await h.api.browsers('list'); const current = h.api.getBridge();
  assert.notEqual(current, old); assert.equal(h.attempts(), 2);
  assert.ok(h.calls.every(call => call.method === 'DSH.hello'));
});

test('ensure never returns a stale page belonging to a different transport', async () => {
  const h = harness();
  const fresh = { closed: false, send: async () => { throw new Error('fresh page command'); } };
  h.api.setBridge(fresh);
  h.api.pages.set('owner-A', { cdp: { closed: true }, sessionId: 'tab-old' });
  // This is independent of browsers(): the next page command must use fresh.
  await assert.rejects(h.api.ensure(), /fresh page command/);
});

test('a stale close event cannot invalidate pages on a newly established transport', async () => {
  const h = harness(); await h.api.browsers('list'); const old = h.api.getBridge();
  old.closed = true; await h.api.browsers('list'); const fresh = h.api.getBridge();
  h.api.pages.set('owner-A', { cdp: fresh, sessionId: 'tab-A' });
  h.links[0].close(); assert.equal(h.api.pages.get('owner-A').cdp, fresh);
});

test('status queues behind capture, reuses its transport, and never claims a page', async () => {
  const h = harness(); const capture = await h.api.openCaptureSession();
  let finished = false; const result = h.api.browsers('list').then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  await capture.close(); assert.match(await result, /bridge: connected/);
  assert.equal(h.attempts(), 1); assert.equal(h.api.pages.size, 0);
  assert.ok(!h.calls.some(call => call.method.startsWith('Target.')));
});

test('status aborts promptly while queued without releasing the active capture or its next job', async () => {
  const h = harness(); const capture = await h.api.openCaptureSession();
  const abort = new AbortController(); let rejected = false, nextStarted = false;
  const checking = h.api.browsers('list', undefined, abort.signal).catch(error => { rejected = true; throw error; });
  const cancelled = assert.rejects(checking, /cancelled/);
  const next = h.api.exclusive(async () => { nextStarted = true; });
  abort.abort(); await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(rejected, true); assert.equal(nextStarted, false);
    assert.equal(h.calls.length, 0); assert.equal(h.attempts(), 1);
    await capture.cdp.send('Runtime.evaluate', { expression: '1' });
  } finally { await capture.close(); }
  await cancelled; await next; assert.equal(nextStarted, true);
  assert.ok(!h.calls.some(call => call.method === 'DSH.hello'));
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('a timed-out status probe removes its abort listener', async () => {
  const h = harness({ stall: true, fastTimers: true }); const abort = new AbortController();
  await assert.rejects(h.api.browsers('list', undefined, abort.signal), /timed out/);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

test('a synchronous transport send failure removes its pending request and abort listener', async () => {
  const h = harness({ fastTimers: true }); const abort = new AbortController();
  const cdp = new h.api.Cdp({ addEventListener() {}, send() { throw new Error('send denied'); } });
  await assert.rejects(cdp.send('DSH.hello', {}, undefined, abort.signal), /send denied/);
  assert.equal(cdp.pending.size, 0);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
});

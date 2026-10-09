import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import vm from 'node:vm';
import * as page from '../lib/page.js';

const source = readFileSync(new URL('../lib/browser.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
function harness(send, overrides = {}) {
  const calls = [];
  const current = { sessionId: 'tab', contexts: new Map([[7, { id: 7, frameId: 'child' }]]), refOwners: new Map([[99, { contextId: 7, localRef: 0 }]]), cdp: { async send(method, params) {
    calls.push({ method, params });
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params?.frameId === 'child' ? 71 : 70 };
    const custom = await send?.(method, params);
    if (method === 'Page.getFrameTree' && !custom?.frameTree) return { frameTree: { frame: { id: 'top' } } };
    return custom ?? {};
  } } };
  const context = { ...page, path, Buffer, process, console, setTimeout, clearTimeout, AbortController, Math, Date, current,
    randomUUID: () => 'test-unique', constants: { X_OK: 1 }, access: async () => {},
    assertBrowserPath: async (file) => file, writeBrowserFile: async (file) => file, readBrowserFile: async () => Buffer.from('png'), ...overrides };
  vm.runInNewContext(source + '\nensure=async()=>current; observe=async()=>"snapshot"; pages.set("test", current); globalThis.api={upload,screenshot,gif,getText,evaluateInPage,fill,a11y,element,uploadImage,delay,onBrowserEvent,query,storage};', context);
  return { api: context.api, calls, current };
}

test('ref reads, evaluation, fill and uploads use iframe context and local ref', async () => {
  const { api, calls, current } = harness((method) => {
    if (method === 'Runtime.evaluate') return { result: { objectId: 'input', value: { ok: true, text: 'child', results: [{ ref: 0, ok: true }] } } };
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 3 } };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'page-node' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: 'from-page' } };
    return {};
  });
  await api.getText({ ref: 99 });
  await api.evaluateInPage('element.textContent', undefined, 99);
  await api.fill([{ ref: 99, value: 'hello' }]);
  await api.upload(99, ['/tmp/existing']);
  current.lastShot = '/tmp/shot';
  await api.uploadImage({ ref: 99 });
  const evaluations = calls.filter((call) => call.method === 'Runtime.evaluate');
  assert.equal(evaluations.length, 5);
  for (const { params } of evaluations) {
    assert.equal(params.contextId, 71);
    assert.doesNotMatch(params.expression, /(?:ref = 99|__dshRefs\[99\]|"ref":99)/);
  }
  assert.match(evaluations[0].params.expression, /var ref = 0/);
  assert.match(evaluations[1].params.expression, /__dshRefs\[0\]/);
  assert.match(evaluations[2].params.expression, /"ref":0/);
  const world = calls.find((call) => call.method === 'Page.createIsolatedWorld');
  assert.equal(world.params.worldName, 'dsh-chrome-refs');
  assert.equal(world.params.grantUniveralAccess, true);
  assert.equal(world.params.frameId, 'child');
  const userCall = calls.find((call) => call.method === 'Runtime.callFunctionOn' && String(call.params.functionDeclaration).includes('element.textContent'));
  assert.ok(userCall);
  assert.equal(userCall.params.contextId, undefined);
  assert.equal(calls.find((call) => call.method === 'DOM.resolveNode' && call.params.backendNodeId === 3).params.executionContextId, 7);
});

test('upload preserves policy errors and does not touch page or misreport missing file', async () => {
  const { api, calls } = harness(null, { assertBrowserPath: async () => { throw new Error('FS_POLICY_DENIED'); } });
  await assert.rejects(api.upload(0, ['/tmp/existing']), /FS_POLICY_DENIED/);
  assert.equal(calls.length, 0);
});

test('screenshot delegates bytes and final path to create-only policy writer', async () => {
  const writes = [];
  const { api } = harness(() => ({ data: Buffer.from('png').toString('base64') }), { writeBrowserFile: async (file, bytes) => { writes.push([file, bytes.toString()]); return '/canonical/new.png'; } });
  const result = await api.screenshot({ path: '/tmp/new.png' });
  assert.deepEqual(writes, [['/tmp/new.png', 'png']]);
  assert.match(result.text, /^saved \/canonical\/new.png/);
});

test('GIF executes available encoder, uses stdout and policy writer, preserves permission errors', async () => {
  const writes = [];
  let spawned;
  const { api } = harness(() => ({ data: Buffer.from('png').toString('base64') }), {
    writeBrowserFile: async (file, bytes) => { writes.push([file, bytes.toString()]); return file; },
    spawn: (encoder, args, options) => {
      spawned = { encoder, args, options };
      const child = new EventEmitter(); child.stdout = new PassThrough();
      queueMicrotask(() => { child.stdout.write(Buffer.from('GIF89a')); child.emit('close', 0); });
      return child;
    },
  });
  await api.gif('start', { cwd: '/tmp/test' });
  const output = await api.gif('stop', { cwd: '/tmp/test' });
  assert.match(output, /saved .*\.gif/);
  assert.equal(spawned.encoder, '/opt/homebrew/bin/ffmpeg');
  assert.ok(spawned.args.includes('pipe:1'));
  assert.ok(!spawned.args.includes('-y'));
  assert.equal(writes.at(-1)[1], 'GIF89a');
  const denied = harness(() => ({ data: Buffer.from('png').toString('base64') }), { access: async () => { throw Object.assign(new Error('encoder denied'), { code: 'EACCES' }); } });
  await denied.api.gif('start', { cwd: '/tmp/test' });
  await assert.rejects(denied.api.gif('stop', { cwd: '/tmp/test' }), /encoder denied/);
});

test('completed delay removes its abort listener', async () => {
  const { api } = harness();
  const listeners = new Set();
  await api.delay(1, { addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener) });
  assert.equal(listeners.size, 0);
});

test('image drop surfaces rejected CDP commands instead of reporting an attempted drop', async () => {
  const { api, current } = harness((method) => {
    if (method === 'Runtime.evaluate') return { result: { value: { ok: false } } };
    if (method === 'Input.dispatchDragEvent') throw new Error('CDP drag rejected');
    return {};
  });
  current.lastShot = '/tmp/shot';
  await assert.rejects(api.uploadImage({ x: 10, y: 20 }), /CDP drag rejected/);
});

function axHarness(fail = false) {
  let ref = 0;
  return harness((method, params) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'top' } } };
    if (method === 'Runtime.evaluate') {
      if (params.returnByValue === false) return { result: { objectId: 'subtree' } };
      if (params.expression.includes('var rootRef')) return { result: { value: { ok: true, tree: [{ ref: 0, role: 'button', name: 'fallback', children: [] }], count: 1 } } };
      return { result: { value: true } };
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 2 } };
    if (method === 'Accessibility.getFullAXTree') {
      if (fail) throw new Error('AX unavailable');
      return { nodes: [
        { nodeId: '1', backendDOMNodeId: 1, childIds: ['2'], role: { value: 'button' }, name: { value: 'outside' } },
        { nodeId: '2', parentId: '1', backendDOMNodeId: 2, role: { value: 'button' }, name: { value: 'inside' } },
      ] };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'button' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { ref: ref++, password: false } } };
    return {};
  });
}

test('a11y replaces stale ownership only after staging references', async () => {
  const { api, current, calls } = axHarness();
  current.refOwners = new Map([[0, { contextId: 7, localRef: 42 }]]);
  const output = await api.a11y({});
  assert.match(output, /outside/);
  assert.equal(current.refOwners.get(0).contextId, 70);
  assert.equal(current.refOwners.get(0).localRef, 0);
  assert.notEqual(current.refOwners.get(0).localRef, 42);
  const commit = calls.find((call) => call.method === 'Runtime.evaluate' && call.params.expression.includes('window.__dshRefs = window['));
  assert.ok(commit);
  assert.equal(commit.params.contextId, 70);
  const world = calls.find((call) => call.method === 'Page.createIsolatedWorld');
  assert.equal(world.params.worldName, 'dsh-chrome-refs');
  assert.equal(world.params.grantUniveralAccess, true);
  assert.ok(!calls.some((call) => call.params?.expression === 'window.__dshRefs = []'));
});

test('a11y subtree resolves original iframe ref, restricts nodes, and remaps returned refs', async () => {
  const { api, current, calls } = axHarness();
  const output = await api.a11y({ ref: 99 });
  assert.match(output, /inside/);
  assert.doesNotMatch(output, /outside/);
  assert.equal(calls.find((call) => call.method === 'Accessibility.getFullAXTree').params.frameId, 'child');
  assert.equal(calls.find((call) => call.method === 'DOM.resolveNode').params.executionContextId, 71);
  assert.equal(current.refOwners.get(0).contextId, 71);
  assert.ok(calls.some((call) => call.method === 'Page.createIsolatedWorld' && call.params.frameId === 'child' && call.params.grantUniveralAccess === true));
  assert.equal(current.refOwners.get(0).localRef, 0);
  assert.equal(current.refOwners.has(99), false);
});

test('a11y fallback also updates ownership in the selected context', async () => {
  const { api, current } = axHarness(true);
  assert.match(await api.a11y({ ref: 99 }), /dom-fallback/);
  assert.equal(current.refOwners.get(0).contextId, 71);
  assert.equal(current.refOwners.has(99), false);
});

function passwordDom() {
  const attributes = { type: 'password', value: 'DUMMY_SECRET' };
  function input(attrs = { ...attributes }) {
    return { tagName: 'INPUT', nodeType: 1, isConnected: true, value: attrs.value || '', children: [],
      getAttribute: (key) => attrs[key] ?? null, setAttribute: (key, value) => { attrs[key] = value; }, removeAttribute: (key) => { delete attrs[key]; },
      matches: () => true, querySelectorAll: () => [], cloneNode: () => input({ ...attrs }),
      get outerHTML() { return `<input type="password"${attrs.value ? ` value="${attrs.value}"` : ''}>`; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }),
    };
  }
  const el = input();
  const document = { body: el, defaultView: { frameElement: null }, querySelector: () => el, querySelectorAll: () => [el] };
  el.ownerDocument = document;
  return { el, context: { document, location: { href: 'https://test/' }, window: { innerHeight: 800, innerWidth: 1000 }, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) } };
}

test('password query, element, fallback a11y and HTML omit raw property and attribute values', () => {
  const { context } = passwordDom();
  const query = vm.runInNewContext(page.queryScript('input', 10), context);
  assert.doesNotMatch(page.formatQuery(query), /DUMMY_SECRET/);
  assert.match(page.formatQuery(query), /redacted/);
  const element = vm.runInNewContext(page.elementScript(0), context);
  assert.doesNotMatch(JSON.stringify(element), /DUMMY_SECRET/);
  const ax = vm.runInNewContext(page.a11yScript({ filter: 'all', depth: 15 }), context);
  assert.doesNotMatch(page.formatA11y(ax), /DUMMY_SECRET/);
  const content = vm.runInNewContext(page.contentScript('', 'html'), context);
  assert.doesNotMatch(content.html, /DUMMY_SECRET/);
});

test('computed AX protected values are redacted even without a bound DOM ref', () => {
  const output = page.formatComputedA11y({ filter: 'all', depth: 15, nodes: [{ nodeId: 'p', role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'DUMMY_SECRET' }, properties: [{ name: 'protected', value: { value: true } }] }] });
  assert.doesNotMatch(output, /DUMMY_SECRET/);
  assert.match(output, /redacted/);
});

test('radio false is honored rather than silently checking the control', () => {
  const { el, context } = passwordDom();
  el.setAttribute('type', 'radio'); el.checked = true; el.dispatchEvent = () => {};
  context.Event = class {};
  context.window.__dshRefs = [el];
  const result = vm.runInNewContext(page.fillScript([{ ref: 0, value: 'false' }]), context);
  assert.equal(result.ok, true);
  assert.equal(el.checked, false);
});

test('frame navigation rebuilds the isolated ref world and recollects refs', async () => {
  const { api, calls, current } = harness((method) => method === 'Runtime.evaluate' ? { result: { value: { ok: true, elements: [], offscreen: [] } } } : {});
  current.mainFrameId = 'top';
  current.refWorlds = new Map([['top', 70]]);
  current.refWorldIds = new Set([70]);
  current.refWorldFrames = new Map([[70, 'top']]);
  api.onBrowserEvent({ method: 'Page.frameNavigated', sessionId: 'tab', params: { frame: { id: 'top' } } });
  await current.refCollect;
  const created = calls.filter((call) => call.method === 'Page.createIsolatedWorld');
  assert.equal(created.length, 1);
  assert.equal(created[0].params.worldName, 'dsh-chrome-refs');
  assert.equal(created[0].params.grantUniveralAccess, true);
  assert.equal(created[0].params.frameId, 'top');
  const collected = calls.find((call) => call.method === 'Runtime.evaluate' && String(call.params.expression).includes('__dshRefs'));
  assert.equal(collected.params.contextId, 70);
});

test('httpOnly cookies are passed to formatCookies and stay redacted', async () => {
  const { api, calls } = harness((method) => method === 'Network.getCookies' ? { cookies: [
    { name: 'theme', value: 'dark', domain: '.example.com', httpOnly: true },
    { name: 'lang', value: 'zh', domain: '.example.com', httpOnly: false },
  ] } : {});
  const text = await api.storage({ area: 'cookie', action: 'list', showValues: true });
  assert.equal(calls.find((call) => call.method === 'Network.getCookies').params.httpOnly, undefined);
  assert.match(text, /theme/);
  assert.match(text, /redacted/);
  assert.doesNotMatch(text, /dark/);
  assert.match(text, /zh/);
});

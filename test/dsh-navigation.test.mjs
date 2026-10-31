import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as page from '../lib/page.js';

function harness(failCookie = false) {
  const calls = [];
  const current = { sessionId: 'tab', cdp: { async send(method, params) {
    calls.push({ method, params });
    if (method === 'Network.setCookie') {
      if (failCookie) throw new Error('private-cookie');
      return { success: true };
    }
    return {};
  } } };
  const context = { ...page, current, URL, AbortController, setTimeout, clearTimeout, console, process, Buffer };
  const source = readFileSync(new URL('../lib/browser.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  vm.runInNewContext(source + `\nensure=async()=>current; exclusive=async fn=>fn(); assertNoDialog=()=>{};
    waitForNavigation=async()=>{}; observe=async()=>"visible page"; shortcutFile=()=>"unused";
    readShortcuts=async()=>({example:[{action:"navigate",url:"http://127.0.0.1:8080/"}]});
    globalThis.api={navigate,batch,shortcut};`, context);
  return { api: context.api, calls };
}

test('direct, batch and shortcut navigation inject cookie before navigating', async () => {
  const { api, calls } = harness();
  const getCookie = async () => ({ name: 'dsh-auth-test', value: 'private-cookie', httpOnly: true });
  assert.equal(await api.navigate('http://127.0.0.1:8080/', { dshBrowserCookie: getCookie }), 'visible page');
  assert.match(await api.batch([{ action: 'navigate', url: 'http://127.0.0.1:8080/' }], undefined, getCookie), /visible page/);
  assert.match(await api.shortcut({ action: 'run', name: 'example', dshBrowserCookie: getCookie }), /visible page/);
  assert.deepEqual(calls.map(call => call.method), ['Network.setCookie', 'Page.navigate', 'Network.setCookie', 'Page.navigate', 'Network.setCookie', 'Page.navigate']);
  for (const call of calls.filter(call => call.method === 'Page.navigate')) assert.equal(call.params.url, 'http://127.0.0.1:8080/');
});

test('cookie injection failures do not navigate or expose private values', async () => {
  const { api, calls } = harness(true);
  await assert.rejects(api.navigate('http://127.0.0.1:8080/', { dshBrowserCookie: async () => ({ value: 'private-cookie' }) }),
    error => error.message === 'DSH browser authorization failed' && error.cause === undefined);
  assert.deepEqual(calls.map(call => call.method), ['Network.setCookie']);
});

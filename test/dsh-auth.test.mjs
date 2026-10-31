import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { dshBrowserCookie } from '../lib/dsh-auth.js';
import { formatCookies } from '../lib/page.js';

test('exchanges only the current local listener and never follows redirects', async (t) => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    const name = `dsh-auth-${createHash('sha256').update(req.headers.host).digest('base64url')}`;
    if (req.url !== '/?token=private-test-token') { res.writeHead(401).end(); return; }
    res.writeHead(303, { location: './', 'set-cookie': `${name}=v1.test.signature; Max-Age=3600; Path=/; Expires=${new Date(Date.now() + 3600000).toUTCString()}; HttpOnly; SameSite=Strict` }).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const services = { webApp: { getAdvertisedUrl: () => origin }, webServer: { getOrigin: () => origin },
    connection: { authenticatedUrl: root => `${root}?token=private-test-token` } };
  const cookie = await dshBrowserCookie(`${origin}/settings`, services);
  assert.equal(calls, 1);
  assert.equal(cookie.value, 'v1.test.signature');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  assert.equal(await dshBrowserCookie('http://127.0.0.1:1/', services), null);
  assert.equal(await dshBrowserCookie(origin, { ...services, webApp: { getAdvertisedUrl: () => 'http://evil.example/' } }), null);
  assert.equal(calls, 1);
  assert.doesNotMatch(formatCookies([{ ...cookie, domain: '127.0.0.1' }], true), /v1\.test\.signature/);
});

test('authorization failures are fixed text and never contain credentials', async () => {
  const origin = 'http://127.0.0.1:1234';
  const services = { webApp: { getAdvertisedUrl: () => origin }, webServer: { getOrigin: () => origin },
    connection: { authenticatedUrl: () => `${origin}/?token=private-test-token` } };
  await assert.rejects(dshBrowserCookie(origin, services, undefined, async () => { throw new Error('private-test-token'); }),
    error => error.message === 'DSH browser authorization failed' && error.cause === undefined);
  await assert.rejects(dshBrowserCookie(origin, services, undefined, async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } })),
    /DSH browser authorization failed/);
});

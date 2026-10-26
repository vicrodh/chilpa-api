const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const build = process.env.CHILPA_PROXY_TEST_BUILD;
assert.ok(build, 'I compile the worker into a temporary folder through test/unit.sh');
const { handleDiscogsOAuth, DISCOGS_CALLBACK } = require(path.join(build, 'discogs-oauth.js'));
const worker = require(path.join(build, 'index.js')).default;
const { handleDiscogs } = require(path.join(build, 'discogs.js'));
const env = { DISCOGS_CLIENT_KEY: 'fixture-key', DISCOGS_CLIENT_SECRET: 'FIXTURE_SECRET' };
function request(route, authorization) {
  return new Request(`https://api.chilpa.app/discogs/oauth/${route}`, {
    headers: { 'User-Agent': 'Chilpa/unit', ...(authorization ? { Authorization: authorization } : {}) }
  });
}
async function mock(fetcher, run) {
  const original = global.fetch;
  global.fetch = fetcher;
  try { await run(); } finally { global.fetch = original; }
}
function fields(header) {
  return Object.fromEntries([...header.matchAll(/(oauth_\w+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeURIComponent(value)]));
}

test('I reject a foreign callback and missing finish secret before upstream access', async () => {
  await mock(() => assert.fail('No upstream request is authorized'), async () => {
    for (const route of ['begin?callback=https://evil.test/callback', 'finish?oauth_token=request&oauth_verifier=code']) {
      const response = await handleDiscogsOAuth(request(route), env, route.split('?')[0]);
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  });
});

test('I sign the temporary credential request and keep the application secret out of begin', async () => {
  await mock(async (url, options) => {
    assert.equal(url, 'https://api.discogs.com/oauth/request_token');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    const signed = fields(options.headers.Authorization);
    assert.equal(signed.oauth_signature_method, 'PLAINTEXT');
    assert.equal(signed.oauth_signature, 'FIXTURE_SECRET&');
    assert.equal(signed.oauth_callback, DISCOGS_CALLBACK);
    assert.ok(signed.oauth_nonce && Number(signed.oauth_timestamp) > 0);
    return new Response('oauth_token=temporary&oauth_token_secret=one-use&oauth_callback_confirmed=true');
  }, async () => {
    const response = await handleDiscogsOAuth(request(`begin?callback=${encodeURIComponent(DISCOGS_CALLBACK)}`), env, 'begin');
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(!body.includes('FIXTURE_SECRET'));
    const value = JSON.parse(body);
    assert.equal(value.request_secret, 'one-use');
    assert.equal(value.authorize_url, 'https://www.discogs.com/oauth/authorize?oauth_token=temporary');
  });
});

test('I exchange a verifier with its header secret and deliver the per-request signing value', async () => {
  await mock(async (url, options) => {
    assert.equal(url, 'https://api.discogs.com/oauth/access_token');
    assert.ok(!url.includes('one-use'));
    const signed = fields(options.headers.Authorization);
    assert.equal(signed.oauth_token, 'temporary');
    assert.equal(signed.oauth_verifier, 'code');
    assert.equal(signed.oauth_signature, 'FIXTURE_SECRET&one-use');
    return new Response('oauth_token=access&oauth_token_secret=access-secret');
  }, async () => {
    const response = await handleDiscogsOAuth(request('finish?oauth_token=temporary&oauth_verifier=code', 'Chilpa one-use'), env, 'finish');
    assert.deepEqual(await response.json(), { consumer_key: 'fixture-key', token: 'access', signature: 'FIXTURE_SECRET&access-secret' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
});

test('I encode both PLAINTEXT secrets before encoding their header parameter', async () => {
  await mock(async (_, options) => {
    assert.equal(fields(options.headers.Authorization).oauth_signature, 'consumer%25%2Fsecret&one-use');
    assert.ok(options.headers.Authorization.includes('consumer%2525%252Fsecret%26one-use'));
    return new Response('oauth_token=access&oauth_token_secret=access-secret');
  }, async () => {
    const response = await handleDiscogsOAuth(request('finish?oauth_token=temporary&oauth_verifier=code', 'Chilpa one-use'),
      { ...env, DISCOGS_CLIENT_SECRET: 'consumer%/secret' }, 'finish');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).signature, 'consumer%25%2Fsecret&access-secret');
  });
});

test('I discard reflected failures, oversized responses and thrown secret-bearing errors', async () => {
  const route = `begin?callback=${encodeURIComponent(DISCOGS_CALLBACK)}`;
  for (const fetcher of [async () => new Response('REFLECTED_SECRET', { status: 401 }),
    async () => new Response('x'.repeat(20000)), async () => { throw new Error('REFLECTED_SECRET'); }]) {
    await mock(fetcher, async () => {
      const response = await handleDiscogsOAuth(request(route), env, 'begin');
      assert.ok(response.status >= 400);
      const body = await response.text();
      assert.ok(!body.includes('REFLECTED_SECRET') && !body.includes('FIXTURE_SECRET'));
    });
  }
});

test('I serve the callback to a regular browser without reflecting script markup', async () => {
  const response = await worker.fetch(new Request('https://api.chilpa.app/discogs/oauth/done?oauth_verifier=%3Cscript%3Eabc%3C%2Fscript%3E', {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.ok(response.headers.get('Content-Security-Policy').includes("default-src 'none'"));
  const html = await response.text();
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('<code>scriptabcscript</code>'));
  assert.equal((await worker.fetch(new Request('https://api.chilpa.app/discogs/oauth/begin', { headers: { 'User-Agent': 'Mozilla/5.0' } }), env)).status, 403);
});

test('I never sign an image or follow its redirect to an unrelated host', async () => {
  let requests = 0;
  await mock(async (_, options) => {
    requests++;
    assert.ok(!('Authorization' in options.headers));
    return new Response(null, { status: 302, headers: { Location: 'https://evil.test/image' } });
  }, async () => {
    const response = await handleDiscogs(new Request('https://api.chilpa.app/discogs/image?url=https%3A%2F%2Fi.discogs.com%2Fimage'), env, 'image');
    assert.equal(response.status, 502);
    assert.equal(requests, 1);
  });
});

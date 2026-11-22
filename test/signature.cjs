const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const build = process.env.CHILPA_PROXY_TEST_BUILD;
assert.ok(build, 'test/unit.sh compiles the worker into a temporary folder');
const { REFUSAL, TIME_HEADER, WINDOW_S, signedBy, unsignedAnswered, withTime } = require(path.join(build, 'signature.js'));
const worker = require(path.join(build, 'index.js')).default;

// The same vectors are in Chilpa's crates/chilpa-api/src/service_signature.rs.
const COUNTING = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
const OTHER = 'ff'.repeat(32);
const T = 1_700_000_000;

function signed(url, method, time, signature) {
  return new Request(url, { method, headers: { 'User-Agent': 'Chilpa', Authorization: `Chilpa-Signature t=${time}, v1=${signature}` } });
}

function sign(key, method, url, time) {
  const { hostname, pathname } = new URL(url);
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(`chilpa-service-v1\n${method}\n${hostname}\n${pathname}\n${time}`).digest('hex');
}

test('the vectors Chilpa signs are recognized, and name the key that made them', async () => {
  const get = signed('https://api.chilpa.app/lastfm?method=track.scrobble', 'GET', T, 'dee612c81e2d81b791f21b2b0377ad09ac0b6b8137fae824c8d8de3daf379556');
  assert.equal(await signedBy(get, `ci:${COUNTING}`, T * 1_000), 'ci');
  const post = signed('https://lyrics.chilpa.app/v1/lyrics/resolve', 'POST', T, '1463868fb51b036297d83a04bcceb054bb5ed579294c3ec8cd4ccd3b120d57a1');
  assert.equal(await signedBy(post, `ci:${OTHER} dev:${COUNTING.toUpperCase()}`, T * 1_000), 'dev', 'each key is tried');
  assert.equal(await signedBy(get, `ci:${OTHER}`, T * 1_000), undefined, 'another key does not match');
  assert.equal(await signedBy(get, undefined, T * 1_000), undefined, 'no keys, nothing is signed');
});

test('a signature covers its method, host, path and time, and not the query', async () => {
  const url = 'https://api.chilpa.app/lastfm?method=one';
  const good = sign(COUNTING, 'GET', url, T);
  const keys = `ci:${COUNTING}`;
  assert.equal(await signedBy(signed('https://api.chilpa.app/lastfm?method=two&more=1', 'GET', T, good), keys, T * 1_000), 'ci');
  for (const [other, method] of [['https://api.chilpa.app/discogs/search', 'GET'], ['https://lyrics.chilpa.app/lastfm', 'GET'], [url, 'POST']]) {
    assert.equal(await signedBy(signed(other, method, T, good), keys, T * 1_000), undefined, `${method} ${other}`);
  }
  assert.equal(await signedBy(signed(url, 'GET', T + 1, good), keys, T * 1_000), undefined, 'the time is signed');
});

test('a time outside the window is refused, either way', async () => {
  const url = 'https://api.chilpa.app/lastfm';
  const keys = `ci:${COUNTING}`;
  for (const drift of [WINDOW_S - 60, -(WINDOW_S - 60)]) {
    assert.equal(await signedBy(signed(url, 'GET', T + drift, sign(COUNTING, 'GET', url, T + drift)), keys, T * 1_000), 'ci', `${drift}`);
  }
  for (const drift of [WINDOW_S + 60, -(WINDOW_S + 60)]) {
    assert.equal(await signedBy(signed(url, 'GET', T + drift, sign(COUNTING, 'GET', url, T + drift)), keys, T * 1_000), undefined, `${drift}`);
  }
});

test('headers of another shape are no signature', async () => {
  const keys = `ci:${COUNTING}`;
  const good = sign(COUNTING, 'GET', 'https://api.chilpa.app/lastfm', T);
  const bad = [
    { Authorization: `Chilpa-Signature v1=${good}` },
    { Authorization: `Chilpa-Signature t=${T}, v2=${good}` },
    { Authorization: `Chilpa-Signature t=${T}.5, v1=${good}` },
    { Authorization: `Chilpa-Signature t=${T}, v1=${good.toUpperCase()}` },
    { Authorization: `Chilpa ${good}` },
    { 'X-Chilpa-Time': String(T), 'X-Chilpa-Signature': `v1=${good}` },
    {}
  ];
  for (const headers of bad) {
    assert.equal(await signedBy(new Request('https://api.chilpa.app/lastfm', { headers }), keys, T * 1_000), undefined, JSON.stringify(headers));
  }
});

test('unsigned requests are answered until the date, and always without one', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  assert.equal(unsignedAnswered(undefined, now), true);
  assert.equal(unsignedAnswered('', now), true);
  assert.equal(unsignedAnswered('2026-12-31', now), true);
  assert.equal(unsignedAnswered('2026-11-30', now), false);
  assert.equal(unsignedAnswered('next month', now), true, 'a date that does not parse keeps the service open');
});

test('every reply carries the clock', async () => {
  const reply = withTime(new Response('ok', { status: 201, headers: { 'Content-Type': 'text/plain' } }), T * 1_000);
  assert.equal(reply.status, 201);
  assert.equal(reply.headers.get(TIME_HEADER), String(T));
  assert.equal(reply.headers.get('Content-Type'), 'text/plain');
  assert.equal(await reply.text(), 'ok');
});

test('past the date, the worker refuses what no key signed and answers what one did', async () => {
  const env = { SERVICE_KEYS: `ci:${COUNTING}`, UNSIGNED_UNTIL: '2000-01-01' };
  const url = 'https://api.chilpa.app/';
  const refused = await worker.fetch(new Request(url, { headers: { 'User-Agent': 'Chilpa/0.1.2 ( https://chilpa.app )' } }), env);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), REFUSAL);
  assert.match(refused.headers.get(TIME_HEADER), /^\d+$/, 'a refusal carries the clock too');

  const now = Math.floor(Date.now() / 1_000);
  const answered = await worker.fetch(signed(url, 'GET', now, sign(COUNTING, 'GET', url, now)), env);
  assert.equal(answered.status, 200);
  assert.equal((await answered.json()).service, 'Chilpa API Proxy');

  const callback = await worker.fetch(new Request('https://api.chilpa.app/discogs/oauth/done'), env);
  assert.notEqual(callback.status, 403, 'the browser callback needs no signature');

  const finish = await worker.fetch(new Request('https://api.chilpa.app/discogs/oauth/finish?oauth_token=t&oauth_verifier=v',
    { headers: { 'User-Agent': 'Chilpa', Authorization: 'Chilpa not-a-real-secret' } }), env);
  assert.notDeepEqual(await finish.json(), REFUSAL, 'the finish carries its own secret, not a signature');

  const open = await worker.fetch(new Request(url, { headers: { 'User-Agent': 'Chilpa' } }), { SERVICE_KEYS: `ci:${COUNTING}` });
  assert.equal(open.status, 200, 'without the date, unsigned requests are answered as before');
});

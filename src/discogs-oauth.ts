/** I exchange temporary OAuth credentials without storing or logging them. */
import type { Env } from './index';
import { json } from './utils';

export const DISCOGS_CALLBACK = 'https://api.chilpa.app/discogs/oauth/done';
const API = 'https://api.discogs.com/oauth';
const USER_AGENT = 'ChilpaAPIProxy/1.4 +https://chilpa.app';
const PRIVATE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

/** RFC 5849 encoding, including characters encodeURIComponent leaves bare. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function header(key: string, secret: string, token = '', tokenSecret = '', extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    oauth_consumer_key: key,
    oauth_nonce: crypto.randomUUID().replaceAll('-', ''),
    oauth_signature_method: 'PLAINTEXT',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature: `${encode(secret)}&${encode(tokenSecret)}`,
    ...extra
  };
  if (token) fields.oauth_token = token;
  return 'OAuth ' + Object.entries(fields).map(([name, value]) => `${name}="${encode(value)}"`).join(', ');
}

function failure(message: string, status: number): Response {
  return json({ error: message }, status, PRIVATE);
}

function safe(value: string | null, limit = 2048): value is string {
  return value !== null && value.length > 0 && value.length <= limit && /^[A-Za-z0-9._~-]+$/.test(value);
}

/** I bound the form response before retaining either token. */
async function form(reply: Response): Promise<URLSearchParams | null> {
  const reader = reply.body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 16384) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new URLSearchParams(new TextDecoder().decode(bytes));
  } finally {
    reader.releaseLock();
  }
}

/** The callback is a browser page, so it does not require Chilpa's UA. */
export function discogsCallback(request: Request): Response {
  if (request.method !== 'GET') return failure('Method not allowed', 405);
  const raw = new URL(request.url).searchParams.get('oauth_verifier') || '';
  const verifier = raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 128);
  const message = verifier ? `<p>Copy this code into Chilpa:</p><code>${verifier}</code>` : '<p>No authorization code was received. Return to Chilpa and try again.</p>';
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Chilpa · Discogs</title><body><h1>Discogs authorization</h1>${message}</body></html>`, {
    headers: { ...PRIVATE, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
  });
}

export async function handleDiscogsOAuth(request: Request, env: Env, route: string): Promise<Response> {
  if (route === 'done') return discogsCallback(request);
  if (!['setup', 'begin', 'finish'].includes(route)) return failure('Not found', 404);
  if (request.method !== 'GET') return failure('Method not allowed', 405);
  const query = new URL(request.url).searchParams;
  const callback = query.get('callback');
  const token = query.get('oauth_token');
  const verifier = query.get('oauth_verifier');
  const authorization = request.headers.get('Authorization') || '';
  const requestSecret = authorization.startsWith('Chilpa ') ? authorization.slice('Chilpa '.length) : '';
  if (['setup', 'begin'].includes(route) && (callback !== DISCOGS_CALLBACK || query.getAll('callback').length !== 1)) {
    return failure('Invalid callback', 400);
  }
  if (route === 'finish' && (!safe(token) || !safe(verifier, 128) || !safe(requestSecret)
      || query.getAll('oauth_token').length !== 1 || query.getAll('oauth_verifier').length !== 1)) {
    return failure('Invalid authorization parameters', 400);
  }
  const key = env.DISCOGS_CLIENT_KEY;
  const secret = env.DISCOGS_CLIENT_SECRET;
  if (!key || !secret) return failure('Discogs is not configured', 503);
  // I let the native client perform both exchanges from its own IP. The
  // shared worker IP can exhaust the OAuth endpoints as well as metadata.
  if (route === 'setup') return json({ consumer_key: key, signature: `${encode(secret)}&` }, 200, PRIVATE);
  try {
    const begin = route === 'begin';
    const auth = begin ? header(key, secret, '', '', { oauth_callback: DISCOGS_CALLBACK })
      : header(key, secret, token!, requestSecret, { oauth_verifier: verifier! });
    const reply = await fetch(`${API}/${begin ? 'request_token' : 'access_token'}`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': USER_AGENT, Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    if (!reply.ok) {
      await reply.body?.cancel();
      const headers: Record<string, string> = { ...PRIVATE, 'X-Chilpa-Upstream-Status': String(reply.status) };
      if (reply.status === 429) {
        const retry = reply.headers.get('Retry-After');
        headers['Retry-After'] = retry && /^\d{1,4}$/.test(retry) ? retry : '60';
      }
      return json({ error: 'Discogs did not accept the authorization' },
        reply.status === 401 ? 401 : reply.status === 429 ? 429 : 502, headers);
    }
    const values = await form(reply);
    const access = values?.get('oauth_token') || '';
    const accessSecret = values?.get('oauth_token_secret') || '';
    if (!safe(access) || !safe(accessSecret) || (begin && values?.get('oauth_callback_confirmed') !== 'true')) {
      return failure('Discogs returned an invalid authorization', 502);
    }
    if (begin) {
      return json({ request_token: access, request_secret: accessSecret,
        authorize_url: `https://www.discogs.com/oauth/authorize?oauth_token=${encode(access)}` }, 200, PRIVATE);
    }
    return json({ consumer_key: key, token: access, signature: `${encode(secret)}&${encode(accessSecret)}` }, 200, PRIVATE);
  } catch {
    return failure('Discogs authorization could not be completed', 502);
  }
}

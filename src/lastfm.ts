/**
 * Last.fm: connecting an account, scrobbles and reads, signed with Chilpa's
 * own API account.
 *
 * Chilpa posts `/lastfm/<method>` with the method's parameters as JSON. The
 * worker adds `method`, `api_key`, `api_sig` and `format=json` and hands
 * Last.fm's answer back as it came; for `auth.getToken` it also returns the
 * page where the person allows Chilpa.
 */

import type { Env } from './index';
import { json, md5, readParams } from './utils';

const API = 'https://ws.audioscrobbler.com/2.0/';

/** The auth and write methods Chilpa calls. */
const WRITES = new Set([
  'auth.getToken',
  'auth.getSession',
  'track.scrobble',
  'track.updateNowPlaying',
  'track.love',
  'track.unlove'
]);

/** A read method: `artist.getInfo`, `user.getRecentTracks`, ... */
const READ = /^[a-z]+\.get[a-z]+$/i;

/**
 * Parameters the worker owns. `method` comes from the path, `api_key` and
 * `api_sig` from the account, and `format` and `callback` stay out of the
 * signature by Last.fm's rules, so a client sending them would break it.
 * QBZ's worker let the body override `method` and got any method signed.
 */
const RESERVED = new Set(['method', 'api_key', 'api_sig', 'format', 'callback']);

/**
 * Chilpa's auth and write methods, plus any read outside `auth.`, so a new
 * read needs no deploy. `auth.getMobileSession` trades a password for a
 * session and stays closed.
 */
export function isAllowed(method: string): boolean {
  return WRITES.has(method) || (READ.test(method) && !method.startsWith('auth.'));
}

/** Last.fm's signature: every parameter sorted by name, then the secret. */
function sign(params: Record<string, string>, secret: string): Promise<string> {
  const base = Object.keys(params).sort().map(key => key + params[key]).join('');
  return md5(base + secret);
}

export async function handleLastFm(request: Request, env: Env, method: string): Promise<Response> {
  if (!isAllowed(method)) {
    return json({ error: 'Method not allowed' }, 400);
  }

  const apiKey = env.LAST_FM_API_KEY;
  const secret = env.LAST_FM_SHARED_SECRET;
  if (!apiKey || !secret) {
    return json({ error: 'Last.fm is not configured' }, 503);
  }

  const client = await readParams(request);
  if (!client) {
    return json({ error: 'Send the parameters as JSON or as a form' }, 400);
  }
  for (const key of RESERVED) {
    delete client[key];
  }

  const params = { ...client, method, api_key: apiKey };
  const query = new URLSearchParams(params);
  query.set('api_sig', await sign(params, secret));
  query.set('format', 'json');

  // Last.fm takes auth.getToken and auth.getSession as GETs, the rest as POSTs.
  let reply: Response;
  try {
    reply = method.startsWith('auth.get')
      ? await fetch(`${API}?${query}`)
      : await fetch(API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: query
        });
  } catch (error) {
    console.error('Last.fm unreachable:', error);
    return json({ error: 'Last.fm did not answer' }, 502);
  }
  const body = await reply.text();

  if (method === 'auth.getToken' && reply.ok) {
    try {
      const { token } = JSON.parse(body) as { token?: string };
      if (token) {
        const authUrl = `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}`
          + `&token=${encodeURIComponent(token)}`;
        return json({ token, authUrl });
      }
    } catch {
      // Not the JSON we expected: hand it back as it came.
    }
  }

  return new Response(body, {
    status: reply.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

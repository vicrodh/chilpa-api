/**
 * PodcastIndex: shows and their episodes, signed with Chilpa's own
 * application.
 *
 * Every call to PodcastIndex carries the key, the time, and a SHA-1 of the
 * key, the secret and that time. The secret cannot ship inside a program
 * anyone can read, so Chilpa asks `/podcastindex/<path>?<query>` here and the
 * worker signs it and hands the answer back as it came.
 *
 * Only reads, and only the paths listed: the worker signs nothing that adds
 * or changes anything on that account.
 *
 * `auth` hands out the signature alone, for clients that make the call
 * themselves. The relayed reads stay for the clients that still ask here.
 */

import type { Env } from './index';
import { json } from './utils';

const API = 'https://api.podcastindex.org/api/1.0/';

/** PodcastIndex asks every client to name itself. */
const USER_AGENT = 'ChilpaAPIProxy/1.2 +https://chilpa.app';

/** The reads Chilpa makes. A new one needs a deploy, on purpose. */
const READS = new Set([
  'search/byterm',
  'search/bytitle',
  'podcasts/byfeedid',
  'podcasts/byitunesid',
  'podcasts/trending',
  'episodes/byfeedid',
  'episodes/byitunesid',
  'episodes/byid',
  'recent/episodes',
  'categories/list'
]);

/**
 * How long a signature handed out by `auth` is offered for, in seconds.
 * PodcastIndex checks the date it carries, not the request it goes on, so
 * one signature serves every call made before it goes stale.
 */
const SIGNATURE_LIFETIME = 120;

/** Hex SHA-1 of a string, which is what PodcastIndex signs with. */
async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isAllowed(path: string): boolean {
  return READS.has(path);
}

/** The three headers PodcastIndex reads, signed for this second. */
async function sign(key: string, secret: string): Promise<{ date: number; headers: Record<string, string> }> {
  const date = Math.floor(Date.now() / 1000);
  return {
    date,
    headers: {
      'X-Auth-Key': key,
      'X-Auth-Date': String(date),
      Authorization: await sha1(key + secret + String(date))
    }
  };
}

export async function handlePodcastIndex(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
  }
  if (path !== 'auth' && !isAllowed(path)) {
    return json({ error: 'Not found' }, 404);
  }

  const key = env.PODCASTINDEX_KEY;
  const secret = env.PODCASTINDEX_SECRET;
  if (!key || !secret) {
    return json({ error: 'PodcastIndex is not configured' }, 503);
  }

  // Only the signature: Chilpa makes the call itself, from the listener's
  // own address, so the replies never pass through here. The secret stays.
  if (path === 'auth') {
    const signed = await sign(key, secret);
    return json(
      { headers: signed.headers, expires_at: signed.date + SIGNATURE_LIFETIME },
      200,
      { 'Cache-Control': 'no-store' }
    );
  }

  // The query goes on as it came. Nothing in it is a credential, and the
  // host is fixed above, so there is nowhere else for the signature to go.
  const target = new URL(path, API);
  target.search = new URL(request.url).search;

  const signed = await sign(key, secret);
  let reply: Response;
  try {
    reply = await fetch(target, { headers: { 'User-Agent': USER_AGENT, ...signed.headers } });
  } catch (error) {
    console.error('PodcastIndex unreachable:', error);
    return json({ error: 'PodcastIndex did not answer' }, 502);
  }

  return new Response(reply.body, {
    status: reply.status,
    headers: {
      'Content-Type': reply.headers.get('Content-Type') || 'application/json',
      ...(reply.headers.has('Retry-After') ? { 'Retry-After': reply.headers.get('Retry-After')! } : {})
    }
  });
}

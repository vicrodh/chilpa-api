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

/** Hex SHA-1 of a string, which is what PodcastIndex signs with. */
async function sha1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function isAllowed(path: string): boolean {
  return READS.has(path);
}

export async function handlePodcastIndex(request: Request, env: Env, path: string): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
  }
  if (!isAllowed(path)) {
    return json({ error: 'Not found' }, 404);
  }

  const key = env.PODCASTINDEX_KEY;
  const secret = env.PODCASTINDEX_SECRET;
  if (!key || !secret) {
    return json({ error: 'PodcastIndex is not configured' }, 503);
  }

  // The query goes on as it came. Nothing in it is a credential, and the
  // host is fixed above, so there is nowhere else for the signature to go.
  const target = new URL(path, API);
  target.search = new URL(request.url).search;

  const date = String(Math.floor(Date.now() / 1000));
  let reply: Response;
  try {
    reply = await fetch(target, {
      headers: {
        'User-Agent': USER_AGENT,
        'X-Auth-Key': key,
        'X-Auth-Date': date,
        Authorization: await sha1(key + secret + date)
      }
    });
  } catch (error) {
    console.error('PodcastIndex unreachable:', error);
    return json({ error: 'PodcastIndex did not answer' }, 502);
  }

  return new Response(reply.body, {
    status: reply.status,
    headers: { 'Content-Type': reply.headers.get('Content-Type') || 'application/json' }
  });
}

/**
 * Discogs: search, a release, and its images, signed with Chilpa's own
 * Discogs application.
 *
 * I sign metadata only at the direct API origin. Images receive no
 * credential and their redirects stay on Discogs hosts.
 */

import type { Env } from './index';
import { json } from './utils';
import { handleDiscogsOAuth } from './discogs-oauth';

const API = 'https://api.discogs.com';

/** Discogs asks every client to name itself. */
const USER_AGENT = 'ChilpaAPIProxy/1.1 +https://chilpa.app';

/** Redirects followed for an image before giving up. */
const MAX_REDIRECTS = 3;

/** What the client needs from Discogs' headers: the type and the pacing. */
const PASSED = [
  'Content-Type',
  'Retry-After',
  'X-Discogs-Ratelimit',
  'X-Discogs-Ratelimit-Used',
  'X-Discogs-Ratelimit-Remaining'
];

/** True for an https URL on discogs.com or one of its subdomains. */
function isDiscogsUrl(target: URL): boolean {
  const host = target.hostname.toLowerCase();
  return target.protocol === 'https:' && (host === 'discogs.com' || host.endsWith('.discogs.com'));
}

/** Discogs' answer as it came, with only the headers worth passing on. */
function passOn(reply: Response): Response {
  const headers = new Headers();
  for (const name of PASSED) {
    const value = reply.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return new Response(reply.body, { status: reply.status, headers });
}

/**
 * I follow an image's redirects by hand without sending a credential.
 */
async function fetchImage(start: URL): Promise<Response> {
  let target = start;
  for (let hop = 0; ; hop++) {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
    if (!isDiscogsUrl(target)) return json({ error: 'Invalid image redirect' }, 502);
    const reply = await fetch(target, { headers, redirect: 'manual' });
    const location = reply.headers.get('Location');
    if (reply.status < 300 || reply.status >= 400 || !location || hop >= MAX_REDIRECTS) {
      return reply;
    }
    target = new URL(location, target);
  }
}

/**
 * Routes:
 * - GET /discogs/search?q=<query>&type=<type>   (type defaults to release)
 * - GET /discogs/release/<id>
 * - GET /discogs/image?url=<https Discogs image URL>
 */
export async function handleDiscogs(request: Request, env: Env, route: string): Promise<Response> {
  if (route.startsWith('oauth/')) return handleDiscogsOAuth(request, env, route.slice('oauth/'.length));
  const query = new URL(request.url).searchParams;
  let target: URL;
  let image = false;

  if (route === 'search') {
    const q = query.get('q');
    if (!q) {
      return json({ error: 'Missing query parameter' }, 400);
    }
    target = new URL(`${API}/database/search`);
    target.searchParams.set('q', q);
    target.searchParams.set('type', query.get('type') || 'release');
    for (const name of ['page', 'per_page']) {
      const value = query.get(name);
      if (value && /^\d+$/.test(value)) {
        target.searchParams.set(name, value);
      }
    }
  } else if (route.startsWith('release/')) {
    const id = route.slice('release/'.length);
    if (!/^\d+$/.test(id)) {
      return json({ error: 'Invalid release ID' }, 400);
    }
    target = new URL(`${API}/releases/${id}`);
  } else if (route === 'image') {
    let start: URL | null = null;
    try {
      start = new URL(query.get('url') || '');
    } catch {
      // Not a URL: refused below.
    }
    if (!start || !isDiscogsUrl(start)) {
      return json({ error: 'Only https Discogs image URLs are allowed' }, 400);
    }
    target = start;
    image = true;
  } else {
    return json({ error: 'Not found' }, 404);
  }

  if (image) {
    const reply = await fetchImage(target);
    if (!reply.ok) {
      return json({ error: 'Failed to fetch image from Discogs' }, reply.status >= 400 ? reply.status : 502);
    }
    return passOn(reply);
  }

  const key = env.DISCOGS_CLIENT_KEY;
  const secret = env.DISCOGS_CLIENT_SECRET;
  if (!key || !secret) {
    return json({ error: 'Discogs is not configured' }, 503);
  }
  const auth = `Discogs key=${key}, secret=${secret}`;

  return passOn(await fetch(target, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT, 'Authorization': auth, 'Accept': 'application/json' }
  }));
}

/**
 * Chilpa API proxy, a Cloudflare Worker at api.chilpa.app.
 *
 * Last.fm signs every call with the application's shared secret, which
 * cannot ship inside a program anyone can read. Chilpa sends the call here
 * and the worker adds the key and the signature. Only Chilpa is served: the
 * QBZ builds still in use keep their own worker, qbz-api-proxy.
 */

import { handleLastFm } from './lastfm';
import { json, logRequest, rateLimit } from './utils';

export interface Env {
  // Chilpa's own Last.fm API account, set with `wrangler secret put`.
  LAST_FM_API_KEY?: string;
  LAST_FM_SHARED_SECRET?: string;
}

const SERVICE = 'Chilpa API Proxy';
const VERSION = '1.0.0';

/**
 * Chilpa sends `User-Agent: Chilpa`. Any program can send that header, so it
 * is not authentication; it keeps the worker from being used by accident.
 */
function isChilpa(request: Request): boolean {
  return (request.headers.get('User-Agent') || '').trim().toLowerCase().startsWith('chilpa');
}

export default {
  async fetch(request, env): Promise<Response> {
    if (!isChilpa(request)) {
      return json({ error: 'This proxy only serves Chilpa' }, 403);
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });
    }

    const limit = rateLimit(request);
    if (!limit.allowed) {
      return json(
        { error: 'Rate limit exceeded', retryAfter: limit.retryAfter },
        429,
        { 'Retry-After': String(limit.retryAfter) }
      );
    }

    logRequest(request);

    const path = new URL(request.url).pathname;
    try {
      if (path === '/') {
        return json({ service: SERVICE, version: VERSION, endpoints: ['/lastfm/*'] });
      }
      if (path.startsWith('/lastfm/')) {
        return await handleLastFm(request, env, path.slice('/lastfm/'.length));
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Worker error:', error);
      return json({ error: 'Internal server error' }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

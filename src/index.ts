/**
 * Chilpa API proxy, a Cloudflare Worker at api.chilpa.app.
 *
 * Some services sign every call with an application secret, which cannot ship
 * inside a program anyone can read. Chilpa sends those calls here and the
 * worker adds the credentials. Only Chilpa is served: the QBZ builds still in
 * use keep their own worker, qbz-api-proxy.
 */

import { handleDiscogs } from './discogs';
import { handleLastFm } from './lastfm';
import { handleMusicBrainz } from './musicbrainz';
import { handlePlaylists } from './playlists';
import { json, logRequest, rateLimit } from './utils';

/** Chilpa's own applications, one secret each, set with `wrangler secret put`. */
export interface Env {
  LAST_FM_API_KEY?: string;
  LAST_FM_SHARED_SECRET?: string;
  DISCOGS_CLIENT_KEY?: string;
  DISCOGS_CLIENT_SECRET?: string;
  MUSICBRAINZ_CLIENT_ID?: string;
  MUSICBRAINZ_CLIENT_SECRET?: string;
  MUSICBRAINZ_CALLBACK_URL?: string;
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
  TIDAL_CLIENT_ID?: string;
  TIDAL_CLIENT_SECRET?: string;
}

const SERVICE = 'Chilpa API Proxy';
const VERSION = '1.1.0';
const ENDPOINTS = ['/lastfm/*', '/discogs/*', '/musicbrainz/oauth/*', '/spotify/playlist/*', '/tidal/playlist/*'];

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
    const [, provider = '', ...rest] = path.split('/');
    const route = rest.join('/');
    try {
      switch (provider) {
        case '':
          return json({ service: SERVICE, version: VERSION, endpoints: ENDPOINTS });
        case 'lastfm':
          return await handleLastFm(request, env, route);
        case 'discogs':
          return await handleDiscogs(request, env, route);
        case 'musicbrainz':
          return await handleMusicBrainz(request, env, route);
        case 'spotify':
        case 'tidal':
          return await handlePlaylists(request, env, provider, route);
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (error) {
      console.error('Worker error:', error);
      return json({ error: 'Internal server error' }, 500);
    }
  }
} satisfies ExportedHandler<Env>;

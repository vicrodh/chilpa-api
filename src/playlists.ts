/**
 * Public playlists from Spotify and Tidal, read with Chilpa's own
 * applications through the client-credentials flow: no user account.
 *
 * QBZ's worker also handed the application's access token to anyone who
 * asked (/spotify/token, /tidal/token). This one never does: the client asks
 * for a playlist and gets the playlist.
 */

import type { Env } from './index';
import { json } from './utils';

interface Service {
  tokenUrl: string;
  api: string;
  accept: string;
  credentials(env: Env): [string, string] | null;
}

const SPOTIFY: Service = {
  tokenUrl: 'https://accounts.spotify.com/api/token',
  api: 'https://api.spotify.com/v1',
  accept: 'application/json',
  credentials: env => pair(env.SPOTIFY_CLIENT_ID, env.SPOTIFY_CLIENT_SECRET)
};

const TIDAL: Service = {
  tokenUrl: 'https://auth.tidal.com/v1/oauth2/token',
  api: 'https://openapi.tidal.com/v2',
  accept: 'application/vnd.api+json',
  credentials: env => pair(env.TIDAL_CLIENT_ID, env.TIDAL_CLIENT_SECRET)
};

function pair(id?: string, secret?: string): [string, string] | null {
  return id && secret ? [id, secret] : null;
}

/** Access tokens per service, kept by the isolate until a minute before they expire. */
const tokens = new Map<Service, { token: string; expiresAt: number }>();

async function accessToken(service: Service, id: string, secret: string): Promise<string | null> {
  const cached = tokens.get(service);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }
  const reply = await fetch(service.tokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${id}:${secret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!reply.ok) {
    console.error(`Token refused by ${service.tokenUrl}: ${reply.status}`);
    return null;
  }
  const { access_token, expires_in } = await reply.json() as { access_token: string; expires_in: number };
  tokens.set(service, { token: access_token, expiresAt: Date.now() + (expires_in - 60) * 1000 });
  return access_token;
}

/**
 * Routes, GET:
 * - /spotify/playlist/<id>           and /spotify/playlist/<id>/tracks?offset=&limit=
 * - /tidal/playlist/<uuid>?countryCode=  and /tidal/playlist/<uuid>/items?countryCode=&page[cursor]=
 * The answer is the service's, as it came.
 */
export async function handlePlaylists(request: Request, env: Env, provider: 'spotify' | 'tidal', route: string): Promise<Response> {
  const query = new URL(request.url).searchParams;
  let path: string;
  let passed: string[];

  if (provider === 'spotify') {
    const match = route.match(/^playlist\/([A-Za-z0-9]{1,64})(\/tracks)?$/);
    if (!match) {
      return json({ error: 'Not found' }, 404);
    }
    path = `/playlists/${match[1]}${match[2] || ''}`;
    passed = ['offset', 'limit', 'market', 'fields'];
  } else {
    const match = route.match(/^playlist\/([0-9a-f-]{36})(\/items)?$/i);
    if (!match) {
      return json({ error: 'Not found' }, 404);
    }
    path = `/playlists/${match[1]}${match[2] ? '/relationships/items' : ''}`;
    passed = ['countryCode', 'include', 'page[cursor]', 'locale'];
  }

  const service = provider === 'spotify' ? SPOTIFY : TIDAL;
  const credentials = service.credentials(env);
  if (!credentials) {
    return json({ error: `${provider === 'spotify' ? 'Spotify' : 'Tidal'} is not configured` }, 503);
  }
  const token = await accessToken(service, ...credentials);
  if (!token) {
    return json({ error: 'The service refused the application credentials' }, 502);
  }

  const target = new URL(service.api + path);
  for (const name of passed) {
    const value = query.get(name);
    if (value !== null) {
      target.searchParams.set(name, value);
    }
  }
  const reply = await fetch(target, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': service.accept }
  });
  return new Response(reply.body, {
    status: reply.status,
    headers: { 'Content-Type': reply.headers.get('Content-Type') || 'application/json' }
  });
}

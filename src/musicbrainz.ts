/**
 * MusicBrainz: only OAuth goes through here.
 *
 * Reads and searches are called by Chilpa directly. MusicBrainz limits by
 * IP, and behind this worker every user would share Cloudflare's addresses;
 * that is what gave QBZ its 503s until it stopped proxying them. What cannot
 * ship inside the app is the client secret, which the token and revoke
 * endpoints ask for, so those two pass through here. The authorize page only
 * needs the client id and the callback, and the worker builds it too so the
 * three values live in one place.
 *
 * PKCE is recommended by MusicBrainz: the client keeps the verifier and sends
 * the challenge to /authorize and the verifier to /token.
 */

import type { Env } from './index';
import { json, readParams } from './utils';

const SITE = 'https://musicbrainz.org';

/** MusicBrainz asks for a name, a version and a way to reach the author. */
const USER_AGENT = 'ChilpaAPIProxy/1.1 ( https://chilpa.app )';

const SCOPES = new Set(['profile', 'email', 'tag', 'rating', 'collection', 'submit_isrc', 'submit_barcode']);

/** Optional authorize parameters and the values each one takes. */
const AUTHORIZE_OPTIONS: Record<string, RegExp> = {
  state: /^[\x21-\x7e]{1,512}$/,
  code_challenge: /^[A-Za-z0-9._~-]{43,128}$/,
  code_challenge_method: /^(S256|plain)$/,
  access_type: /^(online|offline)$/,
  approval_prompt: /^(auto|force)$/
};

/**
 * Routes, parameters as JSON or a form:
 * - POST /musicbrainz/oauth/authorize  {scope, state?, code_challenge?, code_challenge_method?,
 *                                       access_type?, approval_prompt?} -> {authUrl}
 * - POST /musicbrainz/oauth/token      {grant_type: "authorization_code", code, code_verifier?}
 *                                      {grant_type: "refresh_token", refresh_token}
 * - POST /musicbrainz/oauth/revoke     {token}
 * The token and revoke answers are MusicBrainz's, as they came.
 */
export async function handleMusicBrainz(request: Request, env: Env, route: string): Promise<Response> {
  if (!route.startsWith('oauth/')) {
    return json({ error: 'Only MusicBrainz OAuth goes through this proxy; call musicbrainz.org directly' }, 404);
  }
  const step = route.slice('oauth/'.length);
  if (step !== 'authorize' && step !== 'token' && step !== 'revoke') {
    return json({ error: 'Not found' }, 404);
  }

  const params = await readParams(request);
  if (!params) {
    return json({ error: 'Send the parameters as JSON or as a form' }, 400);
  }

  // The request is checked whole before the credentials are touched.
  const scope = (params.scope || '').trim().split(/\s+/).filter(Boolean);
  if (step === 'authorize') {
    if (scope.length === 0 || scope.some(name => !SCOPES.has(name))) {
      return json({ error: `scope is a space-separated list of: ${[...SCOPES].join(', ')}` }, 400);
    }
    for (const [name, allowed] of Object.entries(AUTHORIZE_OPTIONS)) {
      if (params[name] !== undefined && !allowed.test(params[name])) {
        return json({ error: `Invalid ${name}` }, 400);
      }
    }
  } else if (step === 'token') {
    const grant = params.grant_type;
    if (grant === 'authorization_code' ? !params.code : grant === 'refresh_token' ? !params.refresh_token : true) {
      return json({ error: 'Send grant_type authorization_code with code, or refresh_token with refresh_token' }, 400);
    }
  } else if (!params.token) {
    return json({ error: 'Missing token' }, 400);
  }

  const id = env.MUSICBRAINZ_CLIENT_ID;
  const secret = env.MUSICBRAINZ_CLIENT_SECRET;
  const callback = env.MUSICBRAINZ_CALLBACK_URL;
  if (!id || !secret || !callback) {
    return json({ error: 'MusicBrainz is not configured' }, 503);
  }

  if (step === 'authorize') {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      redirect_uri: callback,
      scope: scope.join(' ')
    });
    for (const name of Object.keys(AUTHORIZE_OPTIONS)) {
      if (params[name] !== undefined) {
        query.set(name, params[name]);
      }
    }
    return json({ authUrl: `${SITE}/oauth2/authorize?${query}` });
  }

  const form = new URLSearchParams({ client_id: id, client_secret: secret });
  if (step === 'token') {
    form.set('grant_type', params.grant_type);
    if (params.grant_type === 'authorization_code') {
      form.set('code', params.code);
      form.set('redirect_uri', callback);
      if (params.code_verifier) {
        form.set('code_verifier', params.code_verifier);
      }
    } else {
      form.set('refresh_token', params.refresh_token);
    }
  } else {
    form.set('token', params.token);
  }

  let reply: Response;
  try {
    reply = await fetch(`${SITE}/oauth2/${step}`, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
  } catch (error) {
    console.error('MusicBrainz unreachable:', error);
    return json({ error: 'MusicBrainz did not answer' }, 502);
  }
  return new Response(reply.body, {
    status: reply.status,
    headers: { 'Content-Type': reply.headers.get('Content-Type') || 'application/json' }
  });
}

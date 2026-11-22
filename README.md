# Chilpa API Proxy

I keep the setup for Chilpa's applications in a Cloudflare Worker at
`https://api.chilpa.app`. Released builds carry this address. Discogs OAuth
receives signing material at runtime so both exchanges use the client's IP;
that material is deliberately available to the client.

Requests need `User-Agent: Chilpa...`; anything else gets 403, except the
fixed Discogs browser callback. That is
not authentication, it keeps the worker from being used by accident. GET and
POST only. A provider without its secrets answers 503 `<Provider> is not
configured`. Errors from the worker are JSON `{"error": "..."}`; answers from
a provider come back as the provider sent them, with its status.

## Signed builds

Chilpa builds made with a service key sign every request:

- `X-Chilpa-Time`: seconds since 1970.
- `X-Chilpa-Signature`: `v1=` followed by the lowercase hex HMAC-SHA256 of
  `chilpa-service-v1\n{METHOD}\n{host}\n{path}\n{time}`, where the path
  has no query string.

The `SERVICE_KEYS` secret holds the accepted keys as `name:hex` pairs
separated by spaces, one per build channel; the key that matches names the
channel in the request log. A time more than 15 minutes from the worker's
clock is not accepted, and every reply carries `X-Chilpa-Time` so a client
can sign by the worker's clock. The `UNSIGNED_UNTIL` variable, an ISO date,
sets when unsigned requests start getting 403; without it they are answered
as before. A key travels inside every binary that carries it, so this is not
authentication either: it keeps copies of Chilpa's source from using this
worker by default.

## Forks

If you maintain a fork of Chilpa or ship builds of your own, please deploy
your own copy of this worker, with your own applications' keys, and point
your build to it; Cloudflare's free plan is enough for it. `api.chilpa.app`
and `lyrics.chilpa.app` are for official Chilpa builds, and from a set date
they refuse requests without a valid signature. Their addresses appear in
Chilpa's source as `api.chilpa.app` and `lyrics.chilpa.app`; search for both.

## Last.fm

`POST /lastfm/<method>` with the method's parameters as JSON (a form or a
GET query also work). The worker adds `method`, `api_key`, `api_sig` and
`format=json`; the body cannot set `method`, `api_key`, `api_sig`, `format`
or `callback`.

- Allowed: `auth.getToken`, `auth.getSession`, `track.scrobble`,
  `track.updateNowPlaying`, `track.love`, `track.unlove`, and any
  `<package>.get<Name>` read outside `auth.`; `auth.getMobileSession` is
  closed.
- `auth.getToken` answers `{token, authUrl}`, the page where the person
  allows Chilpa.

## Discogs

I send metadata credentials only to `https://api.discogs.com` and follow no
authenticated redirects. Images receive no credential; their redirects stay
on HTTPS Discogs hosts. The data routes are an anonymous backup for native
clients, which query Discogs directly.

- `GET /discogs/search?q=<query>&type=<type>` (type defaults to `release`;
  `page` and `per_page` pass through): `api.discogs.com/database/search`.
- `GET /discogs/release/<id>`: `api.discogs.com/releases/<id>`.
- `GET /discogs/image?url=<https Discogs image URL>`: the image bytes; any
  other host is 400.

`Retry-After` and the `X-Discogs-Ratelimit*` headers pass through.

I serve these OAuth routes without caching:

- `GET /discogs/oauth/setup?callback=https://api.chilpa.app/discogs/oauth/done`
  returns `{consumer_key, signature}`. The signature is the RFC 5849
  PLAINTEXT base `encode(consumer_secret)&`. The native client combines it
  with each encoded token secret and encodes the header parameter again.
  It posts directly to Discogs' `oauth/request_token` and `oauth/access_token`.
- `GET /discogs/oauth/done` shows a bounded, plain authorization code to a
  regular browser. It has no external resources and does not echo markup.
- I retain `GET /discogs/oauth/begin?callback=...` and `GET /discogs/oauth/finish`
  for earlier clients. Finish takes `oauth_token` and `oauth_verifier` in
  the query and the one-use request secret in `Authorization: Chilpa ...`.
  Both exchanges can receive 429 from the shared worker IP; setup avoids
  using that IP for the exchanges.

The current native flow keeps user access credentials on the client and
verifies identity directly. I never log OAuth response bodies.

## MusicBrainz: OAuth only

Reads and searches are **not** proxied: call `musicbrainz.org` directly. It
limits by IP, and behind the worker every user would share Cloudflare's.
Only the steps that need the client secret come here. Parameters as JSON:

- `POST /musicbrainz/oauth/authorize` `{scope, state?, code_challenge?,
  code_challenge_method?, access_type?, approval_prompt?}` answers
  `{authUrl}` with the client id and the registered callback. `scope` is a
  space-separated list of `profile email tag rating collection submit_isrc
  submit_barcode`. PKCE is recommended: the app keeps the verifier.
- `POST /musicbrainz/oauth/token` `{grant_type: "authorization_code", code,
  code_verifier?}` or `{grant_type: "refresh_token", refresh_token}`.
- `POST /musicbrainz/oauth/revoke` `{token}`.

Token and revoke answers are MusicBrainz's own. Any other `/musicbrainz/`
path is 404.

## Spotify and Tidal: public playlists

Read with the application's client-credentials token, which never leaves the
worker.

- `GET /spotify/playlist/<id>` and `/spotify/playlist/<id>/tracks`
  (`offset`, `limit`, `market`, `fields` pass through).
- `GET /tidal/playlist/<uuid>` and `/tidal/playlist/<uuid>/items`
  (`countryCode`, `include`, `page[cursor]`, `locale` pass through).

## PodcastIndex

Signed with Chilpa's own application: the key, the time and a SHA-1 of the
key, the secret and that time go in headers, added here.

- `GET /podcastindex/<path>?<query>`: `api.podcastindex.org/api/1.0/<path>`,
  with the query as it came.
- `GET /podcastindex/auth`: the signature alone, for a client that makes
  the call itself: `{"headers": {"X-Auth-Key", "X-Auth-Date",
  "Authorization"}, "expires_at": <unix seconds>}`, never cached. The
  replies then go from PodcastIndex to the client, not through here.
- Allowed, all reads: `search/byterm`, `search/bytitle`, `podcasts/byfeedid`,
  `podcasts/byitunesid`, `podcasts/trending`, `episodes/byfeedid`,
  `episodes/byitunesid`, `episodes/byid`, `recent/episodes`,
  `categories/list`. Any other path is 404.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in what you need
npm run dev                      # http://localhost:8787
npm run check                    # TypeScript
npm test                         # isolated protocol fixtures
sh test/smoke.sh                 # against the dev server
```

`UNCONFIGURED="musicbrainz tidal" sh test/smoke.sh` expects those providers
to answer 503 instead of calling out.

## Deploy

```sh
npx wrangler login               # in a real terminal
npx wrangler deploy --env-file /dev/null  # preserves existing worker secrets
sh scripts/put-secrets.sh        # every secret from the owner's secrets file
sh test/smoke.sh https://api.chilpa.app
```

`npx wrangler deployments list` shows the versions;
`npx wrangler rollback <version-id>` goes back to one.

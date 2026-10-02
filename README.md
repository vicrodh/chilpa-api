# Chilpa API Proxy

A Cloudflare Worker at `https://api.chilpa.app` that holds the credentials of
Chilpa's own applications, so no secret ships inside the app. Released
Chilpa builds carry this address; it never changes, the worker behind it can.

Every request needs `User-Agent: Chilpa...`; anything else gets 403. That is
not authentication, it keeps the worker from being used by accident. GET and
POST only. A provider without its secrets answers 503 `<Provider> is not
configured`. Errors from the worker are JSON `{"error": "..."}`; answers from
a provider come back as the provider sent them, with its status.

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

The consumer key and secret go in the `Authorization` header, and only to
https hosts on `discogs.com`, redirects included.

- `GET /discogs/search?q=<query>&type=<type>` (type defaults to `release`;
  `page` and `per_page` pass through): `api.discogs.com/database/search`.
- `GET /discogs/release/<id>`: `api.discogs.com/releases/<id>`.
- `GET /discogs/image?url=<https Discogs image URL>`: the image bytes; any
  other host is 400.

`Retry-After` and the `X-Discogs-Ratelimit*` headers pass through.

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
sh test/smoke.sh                 # against the dev server
```

`UNCONFIGURED="musicbrainz tidal" sh test/smoke.sh` expects those providers
to answer 503 instead of calling out.

## Deploy

```sh
npx wrangler login               # in a real terminal
npx wrangler deploy              # first time: creates api.chilpa.app
sh scripts/put-secrets.sh        # every secret from the owner's secrets file
sh test/smoke.sh https://api.chilpa.app
```

`npx wrangler deployments list` shows the versions;
`npx wrangler rollback <version-id>` goes back to one.

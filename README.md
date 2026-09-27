# Chilpa API Proxy

A Cloudflare Worker at `https://api.chilpa.app` that signs Chilpa's Last.fm
requests, so the shared secret never ships inside the app.

Chilpa sends `POST /lastfm/<method>` with the method's parameters as JSON and
`User-Agent: Chilpa`. The worker adds `method`, `api_key`, `api_sig` and
`format=json` and returns Last.fm's answer as it came. `auth.getToken` also
returns `authUrl`, the page where the person allows Chilpa.

- Only Chilpa is served; anything else gets 403. QBZ has its own worker.
- Allowed: `auth.getToken`, `auth.getSession`, `track.scrobble`,
  `track.updateNowPlaying`, `track.love`, `track.unlove`, and any
  `<package>.get<Name>` read outside `auth.`.
- The body cannot set `method`, `api_key`, `api_sig`, `format` or `callback`.
- MusicBrainz does not go through here: it limits by IP, and behind the
  worker every user would share Cloudflare's.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in a Last.fm API account
npm run dev                      # http://localhost:8787
npm run check                    # TypeScript
sh test/smoke.sh                 # against the dev server
```

## Deploy

```sh
npx wrangler login
npx wrangler deploy              # first time: creates api.chilpa.app
sh scripts/put-secrets.sh        # LAST_FM_API_KEY, LAST_FM_API_SHARED_SECRET
sh test/smoke.sh https://api.chilpa.app
```

`npx wrangler deployments list` shows the versions;
`npx wrangler rollback <version-id>` goes back to one.

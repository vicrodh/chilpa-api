#!/bin/sh
# Checks a running proxy from the outside, the way Chilpa calls it.
#
#   sh test/smoke.sh                          # npx wrangler dev, port 8787
#   sh test/smoke.sh https://api.chilpa.app   # the deployed worker
#
# The checks marked "signed" go out to the real services with the worker's
# credentials, so a deploy missing its secrets never passes. UNCONFIGURED
# names the providers expected to have no secrets, and checks that each of
# them answers 503 instead:
#
#   UNCONFIGURED="musicbrainz tidal" sh test/smoke.sh
#
# Providers: lastfm discogs musicbrainz spotify tidal podcastindex.

set -u

BASE=${1:-http://localhost:8787}
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
FAILURES=0
UA=Chilpa/smoke

# call <user-agent> <http-method> <path> [json-body] -> status in $STATUS
call() {
    if [ $# -ge 4 ]; then
        STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -A "$1" -X "$2" \
            -H 'Content-Type: application/json' --data "$4" "$BASE$3")
    else
        STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -A "$1" -X "$2" "$BASE$3")
    fi
}

# get_encoded <path> <name> <value> -> a GET with one URL-encoded parameter
get_encoded() {
    STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -A "$UA" -G --data-urlencode "$2=$3" "$BASE$1")
}

# expect <name> <status> [text the body must contain]
expect() {
    if [ "$STATUS" != "$2" ]; then
        echo "FAIL $1: status $STATUS, expected $2"
        FAILURES=$((FAILURES + 1))
    elif [ $# -ge 3 ] && ! grep -qF -- "$3" "$BODY"; then
        echo "FAIL $1: body lacks $3"
        FAILURES=$((FAILURES + 1))
    else
        echo "PASS $1"
    fi
}

unconfigured() {
    case " ${UNCONFIGURED:-} " in
        *" $1 "*) return 0 ;;
    esac
    return 1
}

# --- the worker itself -------------------------------------------------------

call "$UA" GET /
expect 'Chilpa is recognized' 200 '"service":"Chilpa API Proxy"'

call 'QBZ/2.1.2' GET /
expect 'QBZ is turned away' 403

call 'curl/8' GET /
expect 'an unknown client is turned away' 403

call "$UA" PUT /
expect 'only GET and POST' 405

call "$UA" GET /spotify/token
expect 'no application token is handed out' 404

call "$UA" GET /bandcamp/anything
expect 'an unknown provider is not found' 404

# --- Last.fm -----------------------------------------------------------------

call "$UA" POST /lastfm/auth.getMobileSession '{"username":"a","password":"b"}'
expect 'lastfm: auth.getMobileSession stays closed' 400 'Method not allowed'

call "$UA" POST /lastfm/playlist.addTrack '{}'
expect 'lastfm: an unlisted write is refused' 400 'Method not allowed'

if unconfigured lastfm; then
    call "$UA" POST /lastfm/auth.getToken '{}'
    expect 'lastfm: without secrets it is unavailable' 503 'not configured'
else
    call "$UA" POST /lastfm/auth.getToken '{}'
    expect 'lastfm signed: a token and the page to allow it' 200 \
        '"authUrl":"https://www.last.fm/api/auth/?api_key='
    TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

    call "$UA" POST /lastfm/auth.getSession "{\"token\":\"$TOKEN\"}"
    expect 'lastfm signed: a token nobody allowed is not a session' 403 '"error":14'

    # Before the fix in QBZ's worker this body ran track.love.
    call "$UA" POST /lastfm/artist.getCorrection '{"method":"track.love","artist":"radiohead"}'
    expect 'lastfm signed: the body cannot choose the method' 200 '"corrections"'

    # Error 9 is a signature accepted and a session rejected; 13 is a bad signature.
    call "$UA" POST /lastfm/track.updateNowPlaying '{"sk":"0000","artist":"Cuca","track":"El Son del Dolor"}'
    expect 'lastfm signed: writes are signed' 403 '"error":9'
fi

# --- PodcastIndex ------------------------------------------------------------

call "$UA" GET /podcastindex/add/byfeedurl
expect 'podcastindex: a path that is not a listed read is not found' 404

call "$UA" POST /podcastindex/search/byterm '{"q":"x"}'
expect 'podcastindex: only GET' 405

if unconfigured podcastindex; then
    call "$UA" GET '/podcastindex/search/byterm?q=radiolab&max=1'
    expect 'podcastindex: without secrets it is unavailable' 503 'not configured'

    call "$UA" GET /podcastindex/auth
    expect 'podcastindex: without secrets there is no signature' 503 'not configured'
else
    call "$UA" GET '/podcastindex/search/byterm?q=radiolab&max=1'
    expect 'podcastindex signed: a search is answered' 200 '"feeds"'

    call "$UA" GET '/podcastindex/podcasts/trending?max=1&lang=es'
    expect 'podcastindex signed: the trending ones of a language' 200 '"feeds"'

    call "$UA" GET /podcastindex/auth
    expect 'podcastindex: the signature alone, with when it goes stale' 200 '"expires_at"'
fi

# --- Discogs -----------------------------------------------------------------

get_encoded /discogs/oauth/begin callback 'https://example.com/callback'
expect 'discogs oauth: a foreign callback is refused' 400 'Invalid callback'

call 'Mozilla/5.0' GET '/discogs/oauth/done?oauth_verifier=%3Cscript%3Eabc%3C%2Fscript%3E'
expect 'discogs oauth: the browser callback renders only a plain code' 200 '<code>scriptabcscript</code>'

call "$UA" GET '/discogs/oauth/finish?oauth_token=request&oauth_verifier=code'
expect 'discogs oauth: a request secret is required in the header' 400 'Invalid authorization parameters'

get_encoded /discogs/image url 'https://example.com/x.jpg'
expect 'discogs: the credentials never go to another host' 400 'Only https Discogs'

get_encoded /discogs/image url 'https://i.discogs.com.evil.net/x.jpg'
expect 'discogs: nor to a host that only starts like Discogs' 400 'Only https Discogs'

call "$UA" GET /discogs/release/abc
expect 'discogs: a release id is a number' 400

if unconfigured discogs; then
    call "$UA" GET '/discogs/search?q=Cuca&type=release'
    expect 'discogs: without secrets it is unavailable' 503 'not configured'
else
    call "$UA" GET '/discogs/search?q=Cuca&type=release'
    expect 'discogs signed: search' 200 '"results"'

    call "$UA" GET /discogs/release/249504
    expect 'discogs signed: a release' 200 '"title"'
    IMAGE=$(tr ',' '\n' < "$BODY" | sed -n 's/.*"uri": *"\(https:\/\/i\.discogs\.com\/[^"]*\)".*/\1/p' | head -n 1)

    if [ -n "$IMAGE" ]; then
        STATUS=$(curl -s -o "$BODY" -w '%{http_code} %{content_type}' -A "$UA" -G --data-urlencode "url=$IMAGE" "$BASE/discogs/image")
        case $STATUS in
            '200 image/'*) STATUS=200 ;;
        esac
        expect 'discogs signed: an image of that release' 200
    else
        echo "FAIL discogs signed: the release carried no image to fetch"
        FAILURES=$((FAILURES + 1))
    fi
fi

# --- MusicBrainz -------------------------------------------------------------

call "$UA" GET '/musicbrainz/ws/2/artist?query=cuca'
expect 'musicbrainz: reads are not proxied' 404 'call musicbrainz.org directly'

call "$UA" POST /musicbrainz/oauth/authorize '{"scope":"admin"}'
expect 'musicbrainz: only known scopes' 400 'scope'

call "$UA" POST /musicbrainz/oauth/token '{"grant_type":"password","username":"a"}'
expect 'musicbrainz: only the code and refresh grants' 400 'grant_type'

CHALLENGE=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
if unconfigured musicbrainz; then
    call "$UA" POST /musicbrainz/oauth/authorize "{\"scope\":\"profile tag\",\"code_challenge\":\"$CHALLENGE\",\"code_challenge_method\":\"S256\"}"
    expect 'musicbrainz: without secrets it is unavailable' 503 'not configured'
else
    call "$UA" POST /musicbrainz/oauth/authorize "{\"scope\":\"profile tag\",\"state\":\"smoke\",\"code_challenge\":\"$CHALLENGE\",\"code_challenge_method\":\"S256\"}"
    expect 'musicbrainz: the page to allow Chilpa' 200 \
        '"authUrl":"https://musicbrainz.org/oauth2/authorize?response_type=code&client_id='

    # invalid_grant means MusicBrainz accepted the client and rejected the
    # code; a wrong secret is invalid_client.
    call "$UA" POST /musicbrainz/oauth/token '{"grant_type":"authorization_code","code":"not-a-real-code"}'
    expect 'musicbrainz signed: the client is accepted' 400 'invalid_grant'
fi

# --- Spotify and Tidal -------------------------------------------------------

call "$UA" GET /tidal/playlist/not-a-uuid
expect 'tidal: a playlist id is a uuid' 404

# A playlist that does not exist: the service's own 404 means it accepted the
# application's token; bad credentials are a 502 from the worker.
if unconfigured spotify; then
    call "$UA" GET /spotify/playlist/0000000000000000000000
    expect 'spotify: without secrets it is unavailable' 503 'not configured'
else
    call "$UA" GET /spotify/playlist/0000000000000000000000
    expect 'spotify signed: the application is accepted' 404
fi

if unconfigured tidal; then
    call "$UA" GET '/tidal/playlist/00000000-0000-0000-0000-000000000000?countryCode=US'
    expect 'tidal: without secrets it is unavailable' 503 'not configured'
else
    call "$UA" GET '/tidal/playlist/00000000-0000-0000-0000-000000000000?countryCode=US'
    expect 'tidal signed: the application is accepted' 404
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "all checks passed against $BASE"
else
    echo "$FAILURES check(s) failed against $BASE"
    exit 1
fi

#!/bin/sh
# Checks a running proxy from the outside, the way Chilpa calls it.
#
#   sh test/smoke.sh                          # npx wrangler dev, port 8787
#   sh test/smoke.sh https://api.chilpa.app   # the deployed worker
#
# The signed checks go out to Last.fm. Without the Last.fm secrets they fail,
# so a deploy missing its secrets never passes. UNCONFIGURED=1 checks the
# other way around: every Last.fm call must answer 503.

set -u

BASE=${1:-http://localhost:8787}
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
FAILURES=0

# call <user-agent> <http-method> <path> [json-body] -> status in $STATUS
call() {
    if [ $# -ge 4 ]; then
        STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -A "$1" -X "$2" \
            -H 'Content-Type: application/json' --data "$4" "$BASE$3")
    else
        STATUS=$(curl -s -o "$BODY" -w '%{http_code}' -A "$1" -X "$2" "$BASE$3")
    fi
}

# expect <name> <status> [text the body must contain]
expect() {
    if [ "$STATUS" != "$2" ]; then
        echo "FAIL $1: status $STATUS, expected $2: $(head -c 200 "$BODY")"
        FAILURES=$((FAILURES + 1))
    elif [ $# -ge 3 ] && ! grep -qF -- "$3" "$BODY"; then
        echo "FAIL $1: body lacks $3: $(head -c 200 "$BODY")"
        FAILURES=$((FAILURES + 1))
    else
        echo "PASS $1"
    fi
}

UA=Chilpa/smoke

call "$UA" GET /
expect 'Chilpa is recognized' 200 '"service":"Chilpa API Proxy"'

call 'QBZ/2.1.2' GET /
expect 'QBZ is turned away' 403

call 'curl/8' GET /
expect 'an unknown client is turned away' 403

call "$UA" PUT /
expect 'only GET and POST' 405

call "$UA" GET /discogs/image
expect 'no route but Last.fm' 404

call "$UA" POST /lastfm/auth.getMobileSession '{"username":"a","password":"b"}'
expect 'auth.getMobileSession stays closed' 400 'Method not allowed'

call "$UA" POST /lastfm/playlist.addTrack '{}'
expect 'an unlisted write is refused' 400 'Method not allowed'

if [ "${UNCONFIGURED:-0}" = 1 ]; then
    call "$UA" POST /lastfm/auth.getToken '{}'
    expect 'without secrets Last.fm is unavailable' 503 'not configured'
else
    call "$UA" POST /lastfm/auth.getToken '{}'
    expect 'auth.getToken hands out a token and the page to allow it' 200 \
        '"authUrl":"https://www.last.fm/api/auth/?api_key='
    TOKEN=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$BODY")

    call "$UA" POST /lastfm/auth.getSession "{\"token\":\"$TOKEN\"}"
    expect 'a token nobody allowed yet is not a session' 403 '"error":14'

    # Before the fix in QBZ's worker this body ran track.love.
    call "$UA" POST /lastfm/artist.getCorrection '{"method":"track.love","artist":"radiohead"}'
    expect 'the body cannot choose the method' 200 '"corrections"'

    # Error 9 means Last.fm accepted the signature and rejected the session;
    # a bad signature is error 13.
    call "$UA" POST /lastfm/track.updateNowPlaying '{"sk":"0000","artist":"Cuca","track":"El Son del Dolor"}'
    expect 'writes are signed' 403 '"error":9'
fi

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "all checks passed against $BASE"
else
    echo "$FAILURES check(s) failed against $BASE"
    exit 1
fi

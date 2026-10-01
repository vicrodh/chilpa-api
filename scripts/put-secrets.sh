#!/bin/sh
# Loads the worker's secrets from the owner's secrets file into Cloudflare.
#
#   sh scripts/put-secrets.sh
#
# The file is ~/Personal/chilpa/.env (CHILPA_SECRETS_FILE overrides it), with
# lines such as LAST_FM_API_KEY=... Each value goes through a pipe straight
# into `wrangler secret put`. Nothing here prints a value: an agent may run
# this script, and whatever it prints reaches the agent's servers.
#
# Last.fm is required. Any other value left empty in the file is skipped, and
# that service answers 503 until it is filled in and this runs again.
#
# Run it after the first `npx wrangler deploy`: each secret publishes a new
# version of a worker that must already exist.

set -eu
set +x

HERE=$(cd "$(dirname "$0")" && pwd)
FILE=${CHILPA_SECRETS_FILE:-"$HERE/../../.env"}

# NAME:shape:need. The shape is checked before anything reaches Cloudflare.
SECRETS='
LAST_FM_API_KEY:hex32:required
LAST_FM_SHARED_SECRET:hex32:required
DISCOGS_CLIENT_KEY:token:optional
DISCOGS_CLIENT_SECRET:token:optional
MUSICBRAINZ_CLIENT_ID:token:optional
MUSICBRAINZ_CLIENT_SECRET:token:optional
MUSICBRAINZ_CALLBACK_URL:callback:optional
SPOTIFY_CLIENT_ID:token:optional
SPOTIFY_CLIENT_SECRET:token:optional
TIDAL_CLIENT_ID:token:optional
TIDAL_CLIENT_SECRET:token:optional
PODCASTINDEX_KEY:token:optional
PODCASTINDEX_SECRET:printable:optional
'

if [ ! -f "$FILE" ]; then
    echo "No secrets file at $FILE" >&2
    exit 1
fi

# The last NAME=value line, without `export`, quotes or a carriage return.
value_of() {
    sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$FILE" \
        | tail -n 1 \
        | tr -d '\r' \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

shape_of() {
    case $1 in
        hex32) echo '^[0-9a-f]{32}$' ;;
        token) echo '^[A-Za-z0-9._~+/=-]{8,256}$' ;;
        # Any visible ASCII and no space: a secret that carries symbols.
        printable) echo '^[!-~]{8,256}$' ;;
        # An http(s) URL, the out-of-band marker, or a private-use scheme in
        # reverse-DNS form (RFC 8252 7.1), such as app.example.name:/callback.
        callback) echo '^(https?://[^[:space:]]+|urn:ietf:wg:oauth:2\.0:oob|[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:[^[:space:]]+)$' ;;
    esac
}

describe() {
    case $1 in
        hex32) echo '32 hex characters' ;;
        token) echo 'one word of 8 to 256 characters' ;;
        printable) echo '8 to 256 visible characters with no space' ;;
        callback) echo 'an http(s) URL, urn:ietf:wg:oauth:2.0:oob, or a reverse-DNS scheme' ;;
    esac
}

# Check every value before touching Cloudflare.
LOAD=''
for entry in $SECRETS; do
    name=${entry%%:*}
    rest=${entry#*:}
    shape=${rest%%:*}
    need=${rest#*:}
    value=$(value_of "$name")
    if [ -z "$value" ]; then
        if [ "$need" = required ]; then
            echo "$name is missing from $FILE" >&2
            exit 1
        fi
        echo "$name: empty, skipped"
        continue
    fi
    # In the C locale, so a range such as [!-~] means the bytes it says.
    if ! printf '%s' "$value" | LC_ALL=C grep -Eq "$(shape_of "$shape")"; then
        echo "$name does not look right (expected $(describe "$shape")); check it in the file" >&2
        # What kind of wrong, never the value.
        if printf '%s' "$value" | grep -q '[[:space:]]'; then
            echo "  it contains spaces: a comment after the value, or a stray space?" >&2
        elif printf '%s' "$value" | grep -q '^[A-Za-z][A-Za-z0-9+.-]*:'; then
            echo "  its scheme is '$(printf '%s' "$value" | sed 's/:.*//')'" >&2
        else
            echo "  it has no scheme (such as http:)" >&2
        fi
        exit 1
    fi
    echo "$name: looks right"
    LOAD="$LOAD $name"
done

cd "$HERE/.."
for name in $LOAD; do
    value_of "$name" | tr -d '\n' | npx wrangler secret put "$name"
done

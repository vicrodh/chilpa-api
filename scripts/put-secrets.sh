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
# Run it after the first `npx wrangler deploy`: each secret publishes a new
# version of a worker that must already exist.

set -eu
set +x

HERE=$(cd "$(dirname "$0")" && pwd)
FILE=${CHILPA_SECRETS_FILE:-"$HERE/../../.env"}
NAMES='LAST_FM_API_KEY LAST_FM_API_SHARED_SECRET'

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

# Check every value before touching Cloudflare.
for name in $NAMES; do
    value=$(value_of "$name")
    if [ -z "$value" ]; then
        echo "$name is missing from $FILE" >&2
        exit 1
    fi
    # Last.fm keys and secrets are 32 hex characters.
    if ! printf '%s' "$value" | grep -Eq '^[0-9a-f]{32}$'; then
        echo "$name does not look like a Last.fm value (32 hex characters); check it in the file" >&2
        exit 1
    fi
    echo "$name: looks right"
done

cd "$HERE/.."
for name in $NAMES; do
    value_of "$name" | tr -d '\n' | npx wrangler secret put "$name"
done

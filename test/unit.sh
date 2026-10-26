#!/bin/sh
set -eu
CHILPA_PROXY_TEST_BUILD=$(mktemp -d)
export CHILPA_PROXY_TEST_BUILD
trap 'rm -rf "$CHILPA_PROXY_TEST_BUILD"' EXIT
./node_modules/.bin/tsc -p . --module commonjs --moduleResolution node --noEmit false --outDir "$CHILPA_PROXY_TEST_BUILD"
node --test test/discogs-oauth.cjs

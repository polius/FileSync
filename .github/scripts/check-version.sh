#!/bin/sh
# Release-version consistency: VERSION is the single source of truth. The compose files must
# pin exactly that image tag, and no tracked file may carry a different release version in
# an image reference or ?v= cache-buster (stale leftovers of an earlier bump).
# Optional $1: the release tag (v4.5.0 / v.4.5.0 / 4.5.0), which must match VERSION too.
set -eu
cd "$(git rev-parse --show-toplevel)"

fail=0
err() { echo "::error::$*"; fail=1; }

version=$(tr -d ' \n\r' < VERSION)
echo "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' \
    || err "VERSION '$version' is not a semantic version"

if [ $# -gt 0 ]; then
    tag=${1#v}; tag=${tag#.}
    [ "$tag" = "$version" ] || err "release tag '$1' does not match VERSION '$version' (bump VERSION first)"
fi

# Every app/init image in the shipped compose files is pinned to VERSION.
for f in deploy/docker-compose.yml deploy/docker-compose-ssl.yml; do
    refs=$(grep -Eo 'image:[[:space:]]*poliuscorp/filesync[^[:space:]]*' "$f" | sed 's/image:[[:space:]]*//')
    [ -n "$refs" ] || err "$f: no poliuscorp/filesync image reference"
    for ref in $refs; do
        [ "$ref" = "poliuscorp/filesync:$version" ] || err "$f: '$ref' should be 'poliuscorp/filesync:$version'"
    done
done

# Anywhere else: a pinned image tag or ?v= cache-buster must be the current version.
stale=$(git grep -nE '(poliuscorp/filesync:|[?&]v=)[0-9]+\.[0-9]+\.[0-9]+' -- . \
        ':!*package-lock.json' ':!web/js/vendors' \
    | grep -vE "(poliuscorp/filesync:|[?&]v=)$(echo "$version" | sed 's/\./\\./g')([^0-9.]|$)" || true)
[ -z "$stale" ] || err "stale version references (expected $version):
$stale"

# The backend reads APP_VERSION / VERSION; a hardcoded version in api/ would drift.
hard=$(git grep -nE "version[[:space:]]*=[[:space:]]*['\"][0-9]+\.[0-9]+\.[0-9]+" -- api || true)
[ -z "$hard" ] || err "hardcoded version in api/ (read it from VERSION instead):
$hard"

[ "$fail" = 0 ] && echo "version $version is consistent"
exit "$fail"

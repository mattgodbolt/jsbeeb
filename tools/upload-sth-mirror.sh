#!/usr/bin/env bash
# Upload a mirror built by tools/mirror-sth.js to s3://bbc.xania.org/archive/sth/.
# Any extra arguments are passed straight to `aws s3 sync`; pass --dryrun to see
# what would be uploaded without touching the bucket.
set -euo pipefail

dir="${1:-.sth-mirror}"
shift || true
dest="s3://bbc.xania.org/archive/sth/"

if [[ ! -f "$dir/manifest.json" ]]; then
    echo "No mirror found at $dir — run 'npm run mirror-sth' first" >&2
    exit 1
fi

# Deliberately no --delete on any of these: the jsbeeb app is served from this
# same bucket, so a mistyped destination could take the site out. Remove files
# from the mirror by hand if it's ever needed.

# Zip paths are content-stable, so they can be cached forever.
aws s3 sync "$dir" "$dest" --no-progress \
    --cache-control "public, max-age=31536000, immutable" \
    --exclude "*manifest.json" --exclude "meta/*" "$@"

# Upstream's changelogs and index pages.
aws s3 sync "$dir" "$dest" --no-progress \
    --cache-control "public, max-age=300" \
    --exclude "*" --include "meta/*" "$@"

# Neither S3 nor the CloudFront distribution in front of it compresses on the
# fly, and the disc catalogue is ~124 KB of JSON that the app fetches whenever
# the archive browser is opened. Pre-compress it — that drops it to ~14 KB, and
# browsers decode Content-Encoding: gzip transparently.
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
while IFS= read -r -d "" manifest; do
    relative="${manifest#"$dir"/}"
    mkdir -p "$staging/$(dirname "$relative")"
    gzip -9 -c "$manifest" >"$staging/$relative"
done < <(find "$dir" -name manifest.json -print0)

aws s3 sync "$staging" "$dest" --no-progress \
    --content-encoding gzip --content-type application/json \
    --cache-control "public, max-age=300" "$@"

# Mirroring scarybeasts' HFE disc archive

`tools/mirror-bbcdiscs.js` mirrors the HFE disc images from scarybeasts' BBC
disc preservation work, catalogued in a Google Sheet and hosted on Google Drive,
into a local tree ready to upload to `s3://bbc.xania.org/archive/bbcdiscs/`.
Mirrored with his permission.

Unlike the STH mirror, the index is a spreadsheet rather than a set of web pages
and the images are flux-derived HFEs rather than zipped sector dumps. Everything
else is the same shape: one manifest per category, blobs uploaded with a long
cache lifetime, manifests with a short one.

The catalogue's URL and the wording of its credit are passed in with `--source`
and `--credit` at run time; nothing here links to it or copies its contents.

## Running it

Export the catalogue with File > Download > CSV and save it as
`.bbcdiscs-sheet.csv`, then:

```sh
npm run mirror-bbcdiscs:check    # parse the catalogue only, report what it says
npm run mirror-bbcdiscs:seed     # pull down what is already mirrored
BEEBJIT=~/dev/beebjit/beebjit npm run mirror-bbcdiscs
npm run mirror-bbcdiscs:upload   # push to S3
```

Publishing needs beebjit: point `BEEBJIT` at the binary, or pass `--beebjit`
when invoking the script directly. Only `:check`, which writes nothing, runs
without it.

Seed first on a fresh machine. A published blob is the disc, so anything already
on S3 is decompressed locally rather than fetched again, and a complete mirror
needs nothing at all from Drive. The archive is most of a gigabyte, all served
by someone else's Drive account.

Seeding relies on the sync leaving the stored encoding alone. If it decodes
`Content-Encoding` on the way down the blobs arrive as plain HFE, and the next
run says so rather than re-uploading them as though they were still compressed.

Uploading needs AWS credentials with write access to the `archive/bbcdiscs/`
prefix of the `bbc.xania.org` bucket, which may not be your default profile:

```sh
AWS_PROFILE=<profile> npm run mirror-bbcdiscs:upload
```

Dry-run both passes first and check that the blobs land in one and the manifests
in the other, because the two tag their objects with very different cache
lifetimes:

```sh
npm run mirror-bbcdiscs:upload:blobs -- --dryrun
npm run mirror-bbcdiscs:upload:index -- --dryrun
```

To work on a handful of discs rather than the whole archive:

```sh
node tools/mirror-bbcdiscs.js --csv .bbcdiscs-sheet.csv --out .bbcdiscs-mirror \
    --filter "<publisher or title>" --limit 6
```

A filtered or limited run knows nothing about the discs it skipped, so it
neither prunes nor writes manifests. It leaves its blobs for the next full run
to pick up, and there is nothing to upload from it.

## What the link column means

A row with no HFE link is not an omission. The catalogue records the disc's
fingerprint either way, and the link is where its owner says whether the image
may be published, which for some publishers he has chosen it should not be.

A link disappearing therefore withdraws a disc, and the mirror follows: a full
run deletes the blob, deletes the cached original, drops it from the manifest
and prints `WITHDRAWN`. `mirror-bbcdiscs:upload:blobs` passes `--delete` so S3
follows too, and nothing else in the pipeline does.

A disc that fails verification is not withdrawn. It is left out of the manifest
but keeps whatever blob it already had.

## Verifying against the catalogue

Every disc is checked before it is published, against four columns that
beebjit's `disc:fingerprint` log reproduces: `CRC32`, `CRC32 as 40 tracks`, the
DFS title and the DFS cycle number.

beebjit reports two fingerprints per side: the whole surface, and the even
tracks alone. A 40 track side written to an 80 track surface is double stepped,
so the even-track fingerprint is the real one. `CRC32` holds whichever of the
two suits the side's density, which the `Tracks` column gives per side, while
`CRC32 as 40 tracks` always holds the even-track one. A flippy with one side of
each density exercises both rules at once.

Discs already published are taken on trust, since a changed fingerprint arrives
as a new blob name rather than as a disc needing another look. `--reverify`
re-checks them anyway, which is what to reach for when the catalogue's other
columns change.

## Layout and formats

```
.bbcdiscs-mirror/
    cache/<drive file id>.hfe   the original download, never uploaded
    hfe/<fingerprint>.hfe       brotli-compressed, uploaded
    hfe/manifest.json
    manifest.json
```

Blobs are named after the disc's CRC32 fingerprint, which is unique across the
catalogue and stable under edits to the prose columns. Downloads are cached
under the Drive file id, which is immutable: fixing a typo in a title must not
cause a gigabyte of re-downloading.

Blobs are stored brotli-compressed and served with `Content-Encoding: br`, so
the browser decodes them and jsbeeb receives the HFE with no work of its own.
These images compress to a few percent of their size. Brotli rather than zstd
because Safari has only had zstd since 26.0, and brotli matches it here anyway.
Compressing at maximum quality is what makes a first full run slow; seeding from
S3 skips it for discs already mirrored.

The cost is that S3 and CloudFront serve a stored encoding unconditionally
rather than negotiating it, so a client that doesn't advertise `br` receives
brotli and has to know to decode it. Browsers, Electron and Node's `fetch` all
do; `curl` needs `--compressed`.

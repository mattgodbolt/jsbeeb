# Mirroring scarybeasts' HFE disc archive

`tools/mirror-bbcdiscs.js` mirrors the HFE disc images from scarybeasts' BBC
disc preservation work, catalogued in a Google Sheet and hosted on Google Drive,
into a local tree ready to upload to `s3://bbc.xania.org/archive/bbcdiscs/`.
Mirrored with his permission.

Unlike the STH mirror, the index is a spreadsheet rather than a set of web
pages, and the images are flux-derived HFEs rather than zipped sector dumps.
Everything else is deliberately the same shape: one manifest per category, blobs
uploaded with a long cache lifetime, manifests with a short one.

The catalogue itself is not this repository's to publish, so its URL and the
wording of its credit are passed in with `--source` and `--credit` at run time.
Nothing here links to it or carries a copy of its contents.

## Running it

Export the catalogue with File > Download > CSV and save it as
`.bbcdiscs-sheet.csv`, then:

```sh
npm run mirror-bbcdiscs:check    # parse the catalogue only, report what it says
npm run mirror-bbcdiscs:seed     # pull down what is already mirrored
BEEBJIT=~/dev/beebjit/beebjit npm run mirror-bbcdiscs
npm run mirror-bbcdiscs:upload   # push to S3
```

Every run that publishes needs beebjit, because publishing a disc asserts it is
the one the catalogue describes and only beebjit can check that. Point `BEEBJIT`
at the binary, or pass `--beebjit` when invoking the script directly. Only
`:check`, which writes nothing, runs without it.

Seed first on a fresh machine. A published blob is the disc, so anything already
on S3 is decompressed locally rather than fetched again, and a mirror that is
already complete needs nothing at all from Drive. That matters: the archive is
about a gigabyte across 725 files, all served by someone else's Drive account.

Seeding also relies on the sync leaving the stored encoding alone. If it decodes
`Content-Encoding` on the way down, the blobs arrive as plain HFE and the next
run says so rather than re-uploading them as if they were still compressed.

Uploading needs AWS credentials with write access to the `archive/bbcdiscs/`
prefix of the `bbc.xania.org` bucket, which may not be your default profile:

```sh
AWS_PROFILE=<profile> npm run mirror-bbcdiscs:upload
```

Dry-run both upload passes first and check that the blobs land in one and the
manifests in the other, because the two tag their objects with very different
cache lifetimes:

```sh
npm run mirror-bbcdiscs:upload:blobs -- --dryrun
npm run mirror-bbcdiscs:upload:index -- --dryrun
```

To work on a handful of discs rather than the whole archive:

```sh
node tools/mirror-bbcdiscs.js --csv .bbcdiscs-sheet.csv --out .bbcdiscs-mirror \
    --filter "<publisher or title>" --limit 6
```

A filtered or limited run knows nothing about the discs it skipped, so it never
prunes, and its manifests describe only what it selected. Don't upload from one.

## What the sheet's link column means

A row with no HFE link is not an omission. The catalogue records the disc's
fingerprint either way, and the link is where its owner says whether the image
is published, which for some publishers they have chosen it should not be.

So a link disappearing is how a disc is withdrawn, and the mirror has to follow.
A full run deletes the blob, drops it from the manifest, deletes the cached
original, and prints `WITHDRAWN`; `mirror-bbcdiscs:upload:blobs` passes
`--delete` so S3 follows too. Nothing else in the pipeline uses `--delete`.

## Verifying against the sheet

Every disc is checked against what the catalogue claims about it before it is
published. beebjit's `disc:fingerprint` log reproduces four of the catalogue's
columns, and a disc that disagrees is reported and left out of the manifest
rather than shipped.

```sh
node tools/mirror-bbcdiscs.js --csv .bbcdiscs-sheet.csv --out .bbcdiscs-mirror \
    --beebjit ~/dev/beebjit/beebjit
```

beebjit reports two fingerprints per side: the whole surface, and the even
tracks alone. A 40 track side written to an 80 track surface is double stepped,
so the even-track fingerprint is the real one. The sheet's `CRC32` column holds
whichever of the two suits the side's density, which the `Tracks` column gives
per side, and its `CRC32 as 40 tracks` column always holds the even-track one.
A flippy with one side of each density exercises both rules at once.

It costs a beebjit run per disc, around 0.4s, and it is the only thing that ties
a link to the disc the catalogue says is behind it. Expect it to find some: a
row whose fingerprint has moved on from the file it links to still reads as a
perfectly good row until something checks.

Discs already published are taken on trust, because a blob is named after its
fingerprint: a CRC32 that changes arrives as a new blob rather than as a disc
that needs looking at again. `--reverify` re-checks them anyway, which is what
to reach for when the sheet's other fingerprint columns change.

Compressing is what actually costs: brotli at maximum quality is around 3.2s for
a 2 MB image, so a first full run is dominated by it. Seeding from S3 skips it
entirely for discs already mirrored.

## Layout and formats

```
.bbcdiscs-mirror/
    cache/<drive file id>.hfe   the original download, never uploaded
    hfe/<fingerprint>.hfe       brotli-compressed, uploaded
    hfe/manifest.json
    manifest.json
```

Blobs are named after the disc's CRC32 fingerprint, which is unique across the
sheet and stable under edits to the prose columns. Downloads are cached under
the Drive file id, which is immutable: fixing a typo in a title must not cause a
gigabyte of re-downloading.

Blobs are stored brotli-compressed and served with `Content-Encoding: br`, so
the browser decodes them and jsbeeb receives the HFE with no work of its own.
That is worth about 24x: an 80 track double-sided image is 2,074,624 bytes raw
and around 88 KB compressed. Brotli rather than zstd because Safari has only
had zstd since 26.0, and brotli matches it on these files anyway.

The cost is that S3 and CloudFront serve a stored encoding unconditionally
rather than negotiating it, so a client that doesn't advertise `br` receives
brotli and has to know to decode it. Every browser and Electron does; `curl`
needs `--compressed`, and tooling written against the mirror needs to care.

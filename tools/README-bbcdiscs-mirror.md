# Mirroring scarybeasts' HFE disc archive

`tools/mirror-bbcdiscs.js` mirrors the HFE disc images from scarybeasts' BBC
disc preservation work into a local tree ready to upload to
`s3://bbc.xania.org/archive/bbcdiscs/`.

They arrive two ways, and the mirror calls each a source:

- `--csv` reads the Google Sheet cataloguing discs captured off the disc itself,
  each row naming a Drive file and the fingerprint it must have.
- `--fsd` reads a directory of discs reconstructed from sector dumps. Nothing
  catalogues these, so all that is known about one comes from the disc and from
  where it sits in the tree.

A source is how a disc is acquired, not how it is published. They share one blob
directory and one manifest, and every entry records its `provenance`, which is
what the picker filters on. Adding a source therefore adds discs, never a second
thing for the site to load.

The wording of the archive's credit is passed in with `--credit` at run time;
nothing here links to the catalogue or copies its contents. The catalogue's own
URL is not recorded anywhere the mirror publishes: the manifests are world
readable, and a link shared with us is not ours to hand on.

## Running it

Export the catalogue with File > Download > CSV and save it as
`.bbcdiscs-sheet.csv`, then:

```sh
npm run mirror-bbcdiscs:check    # parse the catalogue only, report what it says
npm run mirror-bbcdiscs:seed     # pull down what is already mirrored
BEEBJIT=~/dev/beebjit/beebjit npm run mirror-bbcdiscs
npm run mirror-bbcdiscs:upload   # push to S3
```

The reconstructed tree is not published anywhere to fetch from, so it is synced
into `.bbcdiscs-mirror/cache-fsd/` by hand, with rclone against a Drive remote
that can see it.

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

`:upload` reads the published manifest first and asks before doing anything:

```sh
npm run mirror-bbcdiscs:preflight    # the same report, uploading nothing
```

It names the discs that would arrive and the ones that would be withdrawn,
listing every withdrawal and a sample of the arrivals, which is what `aws s3
sync --dryrun` cannot do: that lists the same objects by blob name. It also
stops without asking if the manifest promises a disc that is not there to
upload, or if one already published has changed size under a name that should
have fixed its contents. It will not run unattended; `--yes` says so on purpose.

Dry-run both upload passes too, and check that the blobs land in one and the
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

A run that looked at only some of the archive writes no manifest and prunes
nothing, and there is nothing to upload from it. That covers `--filter`,
`--limit` and `--only <source>`, and it is what stops one source's run
withdrawing another's discs: the manifest describes every disc, and the upload
deletes whatever it leaves out.

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

Only the catalogued source has anything to check against. A reconstructed disc
is still fingerprinted, because the manifest records it, but nothing claims what
it ought to be, and one beebjit cannot read is published without it.

## Layout and formats

```
.bbcdiscs-mirror/
    cache/<drive file id>.hfe   the original download, never uploaded
    cache-fsd/<publisher>/...   the reconstructed tree, synced by hand
    hfe/<blob>.hfe              brotli-compressed, uploaded
    hfe/manifest.json           every disc, whichever source found it
    manifest.json               what the archive is, and how big
```

Every blob lives in `hfe/`, and a manifest names it without a directory, so a
`hfe:<blob>` link means the same thing whatever is added later.

The two sources name blobs differently, and cannot be allowed to collide. A
catalogued disc is named after its CRC32 fingerprint, which the sheet asserts is
its identity and which survives edits to the prose columns. A reconstructed disc
has nothing asserting what it is, and a fingerprint covers only the sectors that
read cleanly, so two discs differing only in their protection would share one:
those are named after a hash of their bytes instead. Eight hex digits or two of
them joined cannot equal sixteen, so the schemes cannot meet, and a run checks
rather than assumes.

Downloads are cached under the Drive file id, which is immutable: fixing a typo
in a title must not cause a gigabyte of re-downloading. Reconstructed discs are
read where they already are and never copied.

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

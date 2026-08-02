# Mirroring the Stairway to Hell archive

`tools/mirror-sth.js` scrapes the BBC Micro, Acorn Electron, and sideways-ROM
areas of `https://www.stairwaytohell.com/` into a local directory tree, which is
then uploaded as-is to `s3://bbc.xania.org/archive/sth/`. jsbeeb's `sth:` URLs
and in-app archive browser read from that mirror rather than from STH directly.

STH has been effectively frozen since around 2008, so this is a one-shot
snapshot, not a continuous sync — there is no scheduled job. Re-run it by hand
if upstream ever changes.

## Running it

```sh
npm run mirror-sth:check    # parse the index pages only, print file counts
npm run mirror-sth          # download everything into .sth-mirror (~80 MB)
npm run mirror-sth:upload   # upload it to S3
```

Uploading needs AWS credentials with write access to the `archive/sth/` prefix
of the `bbc.xania.org` bucket.

The two upload passes split the mirror between them by filename, and getting
those filters wrong would tag thousands of objects with the wrong cache
lifetime. Dry-run both first and check that the zips land in one and the
manifests in the other:

```sh
npm run mirror-sth:upload:blobs -- --dryrun
npm run mirror-sth:upload:index -- --dryrun
```

The download is resumable: files already present are skipped, and downloads land
under a `.part` name until complete, so an interrupted run can't leave a
truncated file behind. To work on one category at a time:

```sh
node tools/mirror-sth.js --out .sth-mirror --category diskimages
```

A single-category run leaves the top-level manifest alone, so it can't drop the
other categories out of the index.

## Being a good guest

STH is a slow box run by volunteers and this pulls several thousand files off
it, so the scrape deliberately runs at four requests at a time and no more than
ten a second overall. `--concurrency` can lower that; think twice before raising
it. Dropped connections and 5xx responses are retried a few times with a
lengthening delay.

A 404 is _not_ retried, and stops the run. If an index page lists a file the
server won't serve, that's a fault worth reporting to the STH folks rather than
something to paper over — so the mirror never quietly omits a file the catalogue
promised. Re-running picks up where it left off, so nothing is lost by stopping.

## What is mirrored

S3 paths mirror STH's own URL structure: `archive/sth/<id>/...`.

| Category                 | Source on STH                                              | Notes                                 |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------- |
| `diskimages/`            | `bbc/archive/diskimages/reclist.php?sort=name&filter=.zip` | ~1,600 zips, ~26 MB                   |
| `tapeimages/`            | `bbc/archive/tapeimages/reclist.php?sort=name&filter=.zip` | ~1,500 zips, ~24 MB                   |
| `sthcollection/`         | `bbc/sthcollection.html`                                   | ~140 zips, magazine disk packs        |
| `other/educational/`     | `bbc/other/educational/reclist.php?...`                    | ~75 zips                              |
| `roms/`                  | `roms/homepage.html`                                       | ~50 BBC + Electron sideways ROMs      |
| `electron/uefarchive/`   | `electron/uefarchive/reclist.php?...`                      | ~890 Electron tape image zips, ~15 MB |
| `electron/dfs/`          | `electron/dfs/homepage.html`                               | ~230 Electron DFS disk images         |
| `electron/adfs/`         | `electron/adfs/homepage.html`                              | ~23 Electron ADFS disk images         |
| `electron/multiplexing/` | `electron/multiplexing/homepage.html`                      | curiosity, 1 file                     |
| `electron/t2p3/`         | `electron/t2p3/homepage.html`                              | curiosity, 4 files                    |

Total ~4,500 zips, ~80 MB. jsbeeb itself only reads `diskimages/` and
`tapeimages/`; the rest is mirrored for completeness.

Alongside the categories, `meta/` holds upstream's changelogs
(`bbc/disklog.txt`, `bbc/tapelog.txt`) and index pages, saved verbatim. It isn't
a category and doesn't appear in any manifest.

## Manifest format (schemaVersion 1)

The top-level `archive/sth/manifest.json` lists the categories and points at
each per-category manifest:

```json
{
  "schemaVersion": 1,
  "name": "Stairway to Hell BBC Micro Software Archive",
  "source": "https://www.stairwaytohell.com/",
  "scrapedAt": "2026-05-03T17:00:00.000Z",
  "categories": [
    {
      "id": "diskimages",
      "title": "BBC Disk Images",
      "manifest": "diskimages/manifest.json",
      "source": "https://www.stairwaytohell.com/bbc/archive/diskimages/",
      "fileCount": 1608,
      "totalBytes": 27315281
    }
  ]
}
```

Each per-category manifest is a flat list of files sorted by path:

```json
{
  "schemaVersion": 1,
  "files": [{ "path": "Acornsoft/Elite.zip", "size": 12345 }]
}
```

Paths are POSIX-style and relative to the category directory, spelled exactly as
upstream's links spell them — jsbeeb's `sth:` URLs embed them verbatim, so
normalising them would break saved links. Sizes are measured from the downloaded
files, not taken from STH's index pages, so a manifest describes what was really
fetched.

## Uploading

The upload is two `aws s3 sync` passes, because the zips want a different cache
lifetime from everything else:

- Zips: `public, max-age=31536000, immutable` — paths are content-stable
- Manifests and `meta/*`: `public, max-age=300` — these change on a re-mirror

The CloudFront distribution in front of the bucket compresses `application/json`
itself, so the manifests go over the wire gzipped without anything here having
to arrange it — the disc catalogue is ~124 KB of JSON but ~14 KB on the wire.

Neither pass uses `--delete`, and neither should: the jsbeeb app is served from
this same bucket, so a mistyped destination could take the site out. Remove
files from the mirror by hand if it's ever needed.

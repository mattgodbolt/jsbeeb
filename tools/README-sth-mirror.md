# Mirroring the Stairway to Hell archive

`tools/mirror-sth.js` scrapes the BBC Micro, Acorn Electron, and sideways-ROM
areas of `https://www.stairwaytohell.com/` into a local directory tree, which
`tools/upload-sth-mirror.sh` uploads to `s3://bbc.xania.org/archive/sth/`.
jsbeeb's `sth:` URLs and in-app archive browser read from that mirror rather
than from STH directly.

STH has been effectively frozen since around 2008, so this is a one-shot
snapshot, not a continuous sync — there is no scheduled job. Re-run it by hand
if upstream ever changes.

## Running it

```sh
npm run mirror-sth:check    # parse the index pages only, print file counts
npm run mirror-sth          # download everything into .sth-mirror (~80 MB)
npm run mirror-sth:upload -- --dryrun   # show what would be uploaded
npm run mirror-sth:upload   # for real
```

Uploading needs AWS credentials with write access to the `archive/sth/` prefix
of the `bbc.xania.org` bucket.

The download is resumable: files already present are skipped, and downloads land
under a `.part` name until complete, so an interrupted run can't leave a
truncated file behind. To work on one category at a time:

```sh
node tools/mirror-sth.js --out .sth-mirror --category diskimages
```

A single-category run leaves the top-level manifest alone, so it can't drop the
other categories out of the index.

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

`tools/upload-sth-mirror.sh` runs three `aws s3 sync` passes, because the three
kinds of file want different headers:

- Zips: `public, max-age=31536000, immutable` — paths are content-stable
- `meta/*`: `public, max-age=300` — these change on a re-mirror
- Manifests: as above, plus `Content-Encoding: gzip`

Manifests are uploaded pre-compressed because neither S3 nor the CloudFront
distribution in front of it compresses on the fly, and the app fetches a whole
category manifest every time the archive browser is opened. Compressing takes
the disc catalogue from ~124 KB to ~14 KB. Browsers decode it transparently, so
`src/sth.js` needs to do nothing special, but `curl` needs `--compressed`:

```sh
curl --compressed https://bbc.xania.org/archive/sth/diskimages/manifest.json
```

No pass uses `--delete`, and none should: the jsbeeb app is served from this
same bucket, so a mistyped destination could take the site out. Remove files
from the mirror by hand if it's ever needed.

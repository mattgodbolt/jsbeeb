# Mirroring the Stairway to Hell archive

`tools/mirror-sth.js` scrapes the public BBC Micro, Acorn Electron, and
sideways-ROM areas of `https://www.stairwaytohell.com/` into a local
directory tree that is sync'd into `s3://bbc.xania.org/archive/sth/` by
`.github/workflows/mirror-sth.yml`.

The mirror exists so jsbeeb's `sth:` URLs and the in-app archive browser
keep working if the upstream site disappears. STH has been effectively
frozen since around 2008 (see `meta/bbc-disklog.txt` and
`meta/bbc-tapelog.txt` in the mirror), so this is a one-shot snapshot
rather than a continuous sync.

## What is mirrored

S3 paths mirror STH's upstream layout — `archive/sth/<id>/...` matches
the natural URL structure on `stairwaytohell.com`.

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
| `meta/bbc-disklog.txt`   | `bbc/disklog.txt`, `bbc/tapelog.txt`                       | upstream changelogs                   |
| `meta/*.html`            | `bbc/homepage.html`, `roms/homepage.html`, etc.            | site index pages, provenance          |

Total ~4,500 zips, ~80 MB across 10 categories.

The Electron categories are mirrored even though jsbeeb does not currently
emulate the Electron — the goal is a complete archival snapshot, not just
what the running app uses today. The `roms/` category similarly overlaps
with what jsbeeb already ships in `public/roms/`; mirroring it is purely
archival.

## Manifest format (schemaVersion 1)

The top-level `archive/sth/manifest.json` lists categories and points at
each per-category manifest:

```json
{
  "schemaVersion": 1,
  "name": "Stairway to Hell BBC Micro Software Archive",
  "source": "https://www.stairwaytohell.com/bbc/",
  "scrapedAt": "2026-05-03T17:00:00Z",
  "categories": [
    {
      "id": "diskimages",
      "title": "Disk Images",
      "manifest": "diskimages/manifest.json",
      "source": "https://www.stairwaytohell.com/bbc/archive/diskimages/",
      "fileCount": 1608,
      "totalBytes": 27315281
    }
  ]
}
```

Each per-category manifest is a flat list of files, sorted by path:

```json
{
  "schemaVersion": 1,
  "files": [{ "path": "Acornsoft/Elite.zip", "size": 12345, "mtime": "2003-04-28T00:00:00.000Z" }]
}
```

Paths are POSIX-style, relative to the category directory.

## Running locally

```sh
# Catalog parse only — no zip downloads. Fast (~2s) sanity check.
node tools/mirror-sth.js --out /tmp/sth-mirror --quick

# Full mirror — ~80 MB, a few minutes depending on STH's bandwidth.
node tools/mirror-sth.js --out /tmp/sth-mirror

# Or just one category:
node tools/mirror-sth.js --out /tmp/sth-mirror --source diskimages
```

The script is resumable: it skips files that are already on disk with the
expected size, so a re-run after a partial download will only fetch what's
missing.

## Running in CI

`.github/workflows/mirror-sth.yml` is `workflow_dispatch` only — no
schedule. The `dry_run` input (default `true`) makes the workflow scrape
into the runner's tmp dir and stop short of uploading. Re-run with
`dry_run: false` once the dry-run output looks right.

The S3 sync is **strictly additive** — there's no `--delete`. If a file
ever needs to be removed from the mirror, do it by hand or in a follow-up
workflow guarded by an explicit `prune` input. This avoids the failure
mode where a typo on the destination URL with `--delete` could nuke the
live app served from the same bucket.

Cache headers:

- Zips: `public, max-age=31536000, immutable` (paths are content-stable)
- Manifests + `meta/*`: `public, max-age=300` (these are what actually
  change when we re-mirror)

## Costs

Storage for ~80 MB of objects is well under one cent per month at S3
standard pricing. Egress is fronted by CloudFront (already in front of
`bbc.xania.org`) and dominated by the existing app traffic; the marginal
cost of mirror traffic is negligible.

# Media registry experiments

Prototype tooling for the [media registry proposal](../../docs/media-registry-proposal.md), and the
experiments behind [its findings](../../docs/media-registry-findings.md). None of it is used by the
emulator.

Everything works on a corpus in `.registry-corpus/` (gitignored):

```sh
node tools/registry/fetch-corpus.js     # our STH and HFE mirrors (about 3.6 GB) and MAME's bbcb_flop.xml
for i in 0 1 2 3 4 5 6 7; do node tools/registry/build-index.js --shard $i/8 & done; wait
cat .registry-corpus/index-*.jsonl > .registry-corpus/index.jsonl
for i in 0 1 2 3 4 5 6 7; do
    node tools/registry/build-index.js --shard $i/8 --sources hfe --track-rule strict --name hfe-strict &
done; wait
cat .registry-corpus/hfe-strict-*.jsonl > .registry-corpus/hfe-strict.jsonl
node tools/registry/analyse.js          # every number in the findings
```

Other images can be dropped into `.registry-corpus/bbcmicro/` (any sector images or zips of them), which
is where the bbcmicro.co.uk image zip was unpacked for the findings.

- `fingerprint.js`: the fingerprint itself. Sector images are hashed from their bytes; flux images are
  loaded with jsbeeb's disc code and decoded back into the same bytes.
- `dfs.js`: reads a DFS catalogue from a side's bytes and hashes each file.
- `build-index.js`: one JSON line per image, with its keys, what trimming removed, what the flux decode
  dropped, and its catalogue. `--track-rule strict` selects the first draft's rule, which drops sectors
  whose header names another track.
- `analyse.js`: prints every number in the findings from the indexes; `--family exile` lists one game's
  images and their files.
- `check-paths.js`: loads every sector image through jsbeeb and checks the flux path gives back the same
  bytes.
- `fill-survey.js`: which repeated bytes pad the ends of sector images.
- `diff-images.js <ref> <ref>`: compares two images sector by sector and says whether the differences are
  in the catalogue, a named file or free space. A ref is a path under the corpus, with `#member` for a
  file in a zip.

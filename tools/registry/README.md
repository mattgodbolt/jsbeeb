# Media registry experiments

Prototype tooling for the [media registry proposal](../../docs/media-registry-proposal.md), and the
experiments behind [its findings](../../docs/media-registry-findings.md). None of it is used by the
emulator.

Everything works on a corpus in `.registry-corpus/` (gitignored):

```sh
node tools/registry/fetch-corpus.js     # our STH and HFE mirrors (about 3.6 GB) and MAME's bbcb_flop.xml
index() { # name, then build-index.js options
    for i in 0 1 2 3 4 5 6 7; do node tools/registry/build-index.js --shard $i/8 --name "$@" & done; wait
    cat .registry-corpus/$1-*.jsonl > .registry-corpus/$1.jsonl
}
index index                                                                  # the proposal's rules
index hfe-first-draft --sources hfe --track-rule strict --pitch-test headers # the first draft's
index hfe-headers --sources hfe --pitch-test headers                         # only the pitch test reverted
node tools/registry/analyse.js
```

Other images can be dropped into `.registry-corpus/bbcmicro/` (any sector images or zips of them), which
is where the bbcmicro.co.uk image zip was unpacked for the findings.

- `fingerprint.js`: the fingerprint itself. Sector images are hashed from their bytes; flux images are
  loaded with jsbeeb's disc code and decoded back into the same bytes.
- `dfs.js`: reads a DFS catalogue from a side's bytes and hashes each file.
- `build-index.js`: one JSON line per image, with its keys, what trimming removed, what the flux decode
  dropped, and its catalogue. `--track-rule strict` selects the first draft's rule, which drops sectors
  whose header names another track.
- `analyse.js`: prints the findings' numbers that come from the three indexes; `--family exile` lists one
  game's images and their files.
- `split-diffs.js`: diffs every group of captures the first draft gave one key and the proposal splits.
- `check-paths.js`: loads every sector image through jsbeeb and checks the flux path gives back the same
  bytes.
- `fill-survey.js`: which repeated bytes pad the ends of sector images.
- `diff-images.js <ref> <ref>`: compares two images sector by sector and says whether the differences are
  in the catalogue, a named file or free space. A ref is a path under the corpus, with `#member` for a
  file in a zip.

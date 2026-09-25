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

The fingerprint and its index:

- `fingerprint.js`: the fingerprint itself. Sector images are hashed from their bytes; flux images are
  loaded with jsbeeb's disc code and decoded back into the same bytes. It also gives each flux side as a
  filesystem addresses it, which is what catalogues are read from.
- `dfs.js`: reads a DFS catalogue from a side's bytes and hashes each file.
- `build-index.js`: one JSON line per image, with its keys, what trimming removed, what the flux decode
  dropped, and its catalogue. `--track-rule strict` and `--pitch-test headers` select the first draft's
  rules.
- `analyse.js`: prints the findings' numbers that come from the three indexes; `--family exile` lists one
  game's images and their files.
- `check-paths.js`: loads every sector image through jsbeeb and checks the flux path gives back the same
  bytes.
- `fill-survey.js`: which repeated bytes pad the ends of sector images.
- `split-diffs.js`: diffs every group of captures the first draft gave one key and the proposal splits.

Looking at images:

- `diff-images.js <ref> <ref>`: compares two images sector by sector and says whether the differences are
  in the catalogue, a named file or free space. A ref is a path under the corpus, with `#member` for a
  file in a zip.
- `inspect.js`: lists a catalogue, and dumps, diffs, disassembles or lists (as BASIC) a file on an image.

The studies:

- `cluster.js`: families of discs by the files they share, `contains` relations, and a check against the
  HFE mirror's labels (writes `clusters.jsonl` and `contains.jsonl`).
- `judge-sample.js`: draws the judging pilot's sample; `pilot/` holds the sample used and both judges'
  verdicts.
- `fsd.js`, `fsd-study.js`, `fsd-unreadable.js`: FSD sector dumps (from Matt's NAS, `--fsd-dir`) against
  the mirror's reconstructions of them.
- `tape.js`, `tape-index.js`, `tape-analyse.js`: UEF and CSW decoding, the tape key, and tape files
  against disc files (`--nas` for the NAS's tapes).
- `adfs-survey.js`: ADFS images, from `.registry-corpus/adfs/` and the HFE mirror.
- `anchors.js`, `anchors-run.js`: symbol-set anchors chosen from a py8dis listing, and checked against a
  game running headless.
- `boot-survey.js`, `boot-survey-analyse.js`, `boot-survey-screen.js`: boots every distinct disc on a
  Model B and a Master and records how far it gets. It takes a couple of hours:

  ```sh
  for i in $(seq 0 31); do nice -n 19 node tools/registry/boot-survey.js --shard $i/32 & done; wait
  cat .registry-corpus/boot-survey-{0..31}.jsonl > .registry-corpus/boot-survey.jsonl
  node tools/registry/boot-survey-analyse.js
  ```

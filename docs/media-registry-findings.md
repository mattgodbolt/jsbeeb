# Media registry: first findings from the archive

These are the results of running a prototype of the fingerprint from the [media registry
proposal](media-registry-proposal.md) over every disc image we could lay hands on, fetched on 24
September 2026. The tools are in `tools/registry/` (see its README): `build-index.js` fingerprints the
corpus, `analyse.js` prints the numbers that come from the indexes, and `fill-survey.js`,
`check-paths.js`, `split-diffs.js` and `diff-images.js` do the checks that need the images themselves.
Our mirrors are live, so a later fetch may not give exactly these numbers; MAME's list is pinned to a
commit.

## What went in

| Source                       | Images | What they are                                               |
| ---------------------------- | -----: | ----------------------------------------------------------- |
| Our HFE mirror               |  1,985 | flux captures of original discs, many of them protected     |
| Our Stairway To Hell mirror  |  1,625 | SSDs and DSDs, from 1,608 zips                              |
| The bbcmicro.co.uk image zip |  4,150 | SSDs, DSDs and a couple of ADLs, analysed privately         |
| MAME's `bbcb_flop.xml`       |    326 | hashes only, compared against the others' whole-file SHA-1s |

That's 7,760 images. Tapes aren't in yet. Only aggregate numbers from the bbcmicro.co.uk images appear
here; nothing about individual entries is published.

## The two paths agree

The proposal hashes sector images from their bytes and flux images by decoding them. As a check that the
two are really the same thing, every sector image in the corpus (5,775 of them) was also loaded by
jsbeeb, decoded through the flux path and trimmed. All 5,775 gave exactly the same bytes both ways.

## Exact matches across sources are rare

| Disc keys found in          | Count |
| --------------------------- | ----: |
| bbcmicro.co.uk and STH      |    57 |
| bbcmicro.co.uk and HFE      |     4 |
| bbcmicro.co.uk, HFE and STH |     2 |
| HFE and STH                 |     1 |

Out of 7,365 distinct disc keys, only 64 turn up in more than one source. We'd expected a lot more.

The main reason is that the archive images are mostly re-mastered copies, with the files written out
again by some tool, rather than dumps of the original discs. Of the 423 captures that share at least half
their files (counting files of 512 bytes or more) with a Stairway To Hell SSD, 371 have those files at
different sectors on the SSD. Return of the Jedi is typical: the capture has 11 files and the SSD 12,
with an extra `$.LOAD` and a different `$.!BOOT`, the files sit elsewhere (the capture's `$.!BOOT` is at
sector 143, the SSD's at sector 2), the disc title has become `RETURNOFJEDI`, and the cycle number is 6
rather than 39. No disc fingerprint will ever match those, and it shouldn't try: that's exactly the
`*COMPACT` case, and it belongs to the file-level matching, not the key.

Even the closest cases rarely match. 14 captures have exactly the same DFS files, names and contents, as
an archive image, 13 of them against a Stairway To Hell SSD, and still get a different key. Of those 16
pairs, 11 have the files moved and a different title or cycle number, like Colossus Chess (the capture
has `$.G30` at sector 122, the SSD at sector 2), and one more has the files moved but the same title and
cycle. The other four, all Cheat It Again Joe discs, have the files in the same place (one with a
different cycle number) and differ in whole sectors of free space, plus a byte or two of the catalogue,
which looks like old data on a reused disc.

An exact key over the set of files (names, addresses and contents) doesn't help much either: 72
cross-source matches rather than 64, because images that share most of their files usually differ in a
small one, such as `!BOOT` or an added loader. Linking the archives together is going to be a similarity
job.

## What the fingerprint does buy

The 7,696 distinct files collapse to 7,365 disc keys. Most of that is repeat copies: the HFE mirror's
1,985 files are 1,661 distinct discs, because the same disc has often been captured more than once, or
captured and also reconstructed from an FSD dump, and those agree.

## Protection, and a rule that had to go

The first draft of the flux path kept only sectors whose header named the track they were read from. The
sectors it dropped from side 0 of the HFE captures:

| Wrong-track sectors on side 0 | Captures |
| ----------------------------- | -------: |
| none                          |    1,542 |
| 1 to 10                       |       98 |
| 11 to 100                     |      114 |
| over 100                      |      231 |

The captures with hundreds are the interesting ones. Here's what jsbeeb decodes from an Exile capture,
taken in an 80-track drive, so that physical track 4 is the disc's track 2:

```
physical  0: track 0,   sectors 0..9
physical  4: track 200, sectors 100..109
physical 10: track 197, sectors 103..112
physical 20: track 192, sectors 108..117
physical 40: track 182, sectors 118..127
```

Superior's protection renumbers every track after track 0, and the game lives on those tracks. The rule
threw all of it away and kept track 0: a stub catalogue and a loader, which Exile and Repton Infinity
share byte for byte. So Exile and Repton Infinity shared a key, twice over: once for the two games'
captures, and once for the images labelled "Exile v1" and "Repton Infinity Game Disc Master". A key made
of a publisher's boot track is worse than no key at all.

The fix keeps every sector with good CRCs, whatever its header claims, and orders them by the track they
were read from first. Comparing the first draft with the proposal (both its track rule and its pitch
test, below) over the whole HFE mirror:

- All 1,542 captures the first draft dropped no wrong-track sectors from keep exactly the same key.
- Under the first draft, 9 keys were shared by captures whose titles have no word in common, two of them
  the Exile and Repton Infinity pairs. Under the proposal there are 6, and all six are the same title
  written differently: E-Type and E Type, Fire Track and Firetrack, Q-Master and Q Master, ViewStore and
  View Store, The Dam Busters and Dambusters, and Cheat It Again Joe and its abbreviation, CIAJ Vol 1.
- The proposal splits 17 groups the first draft merged. Most of those are copies that differ in tens to
  hundreds of sectors, which the first draft only merged because it had thrown away the protected tracks:
  the two Exile and Repton Infinity pairs, Arcadians, Turtle Graphics, Grand Prix Construction Set,
  Computer Maniacs Diary, Cheat It Again Joe, Spellbinder, Uridium, Revs, Sphinx Adventure, one
  Philosophers Quest pair and Hopper v1 against v2. Carousel's split is between the mirror's v1 and v2,
  which differ in seven sectors, and 3D Pool's between the two sides of a dual-format disc, which differ
  only past the end of the 40-track side.

The rest are the cost. Three groups are near-identical copies that the proposal now keeps apart: Hopper
v1 against a reconstruction of it, which differ by one byte in each of three sectors; The Empire Strikes
Back, whose capture and reconstruction differ in one sector; and a Philosophers Quest pair that differs
in four. All three sit on the protected tracks with good CRCs, and in each pair one image is a direct
capture and the other was reconstructed from an FSD dump, so the difference may be in how the FSD
recorded those sectors rather than on the discs. Either way the registry has to link them with an alias
rather than a shared key. `split-diffs.js` prints all of this.

## Which track is which

Keeping renumbered sectors raised a second problem. To know which physical tracks to read, the
fingerprint has to decide whether a side is a 40-track disc read in an 80-track drive, and the obvious
test (do the headers on the even tracks give half their track number?) can't see through renumbering
either. The Exile captures above, taken in an 80-track drive, were judged 80-track, so its odd tracks,
which only hold ghosts of their neighbours, went into the key, and they stopped matching the copies
reconstructed from FSD dumps.

Looking for ghosts instead (odd tracks whose sectors are all copies of an even neighbour's) fixes that
case, but a disc can legitimately repeat a track, and a ghost test alone would call a 40-track drive's
capture of such a disc double-stepped and throw away half its tracks. So the proposal combines them. If
nothing past physical track 50 holds data, every track that does is taken as real, which covers captures
from 40-track drives and discs whose data stops early; otherwise the side is 40-track if at least four
even tracks carry headers for half their number (and more of them than carry their own), or if at least
four even tracks hold data and fewer than a tenth as many odd tracks hold anything but ghosts. Against
the header test alone, six captures change key. Four are Superior discs captured in an 80-track drive:
the Exile v1 and v2 captures, which now match their reconstructions, and two Repton Infinity captures.
The other two (Replica 3 and a Genie Utilities reconstruction) are 80-track discs whose data stops before
track 40, with leftovers of a 40-track format further in; the header test called them 40-track and threw
away the real data on their odd tracks. No group of captures that agreed under the header test is split.

## Trailing fill

Across 5,823 sides of sector images, the sectors trimmed off the end were `&E5` on 3,978 sides and `&00`
on 167. Any other repeated byte turned up on 7 sides in total (`&30`, `&29`, `&F0`, `&20`, `&6C`, `&0F`),
and a run of spaces or zeros at the end of a file could just as easily be real data. So trimming stays
limited to `&00` and `&E5`.

## Side keys

Only 64 images are double-sided (one of them has a second side that trims to nothing), and 11 of their
side keys also turn up on another disc. Ten of those are the same title; the eleventh is shared by two
unrelated discs, which is exactly what the `ambiguous` record for shared side keys is for. It'll be rare,
but it isn't imaginary.

## MAME

32 of the 326 images in MAME's BBC disc list match a corpus image by whole-file SHA-1 (23 Stairway To
Hell images and 10 bbcmicro.co.uk ones, one of them in both). MAME's list says it was compiled from the
Stairway To Hell archive and that none of its images are protected, and most of them no longer match what
the archive holds today. Its value to the registry is its short names and parent/clone structure rather
than its hashes.

## A look at Exile

Across our own two mirrors, Exile falls into families quite naturally:

- The original protected discs: v1 and v2, each captured and also reconstructed from an FSD dump, a
  review copy, and others. Each now gets a key covering the whole disc, and the capture and the
  reconstruction of v1 agree, as do those of v2.
- A plain DFS version (the mirror calls it v3), with three copies. Two are the two sides of one
  dual-format disc, a 40-track side and an 80-track side holding the same files, and they agree because
  the 80-track side's extra tracks trim away. The third, reconstructed from an FSD dump, differs only in
  the catalogue's cycle number (49 against 17): that disc had been written to at some point.
- The Stairway To Hell `Superior/Exile.ssd`, a deprotected copy with a loader file of its own.
- Several cheat and editor discs from Stairway To Hell's `Cheats` folder, which share `EXILEL`, `EXEDIT`
  and `MAPPER` with each other and not with the game discs.

Shared files find those families without any help, which is encouraging for the clustering step. Saying
which one is the original, which is a crack and which is a modified version is the part that needs
judgement: it means reading loaders and diffs, not just comparing hashes.

---

This write-up was drafted by Claude (an LLM) with Matt, from experiments run with the tools in
`tools/registry/`.

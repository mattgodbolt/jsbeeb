# Media registry: first findings from the archive

These are the results of running a prototype of the fingerprint from the [media registry
proposal](media-registry-proposal.md) over every disc image we could lay hands on. The tools are in
`tools/registry/` (see its README): `build-index.js` fingerprints the corpus, `analyse.js` prints every
number quoted here, and `fill-survey.js` and `check-paths.js` do the two checks that need the images
themselves.

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

Out of 7,365 distinct disc keys, only 64 turn up in more than one source. We'd expected a lot more, so we
looked at the near misses: 14 captures have exactly the same DFS files (names and contents) as an archive
image but a different key, 13 of them against a Stairway To Hell SSD. The three we looked at closely were
all the same story. The Return of the Jedi capture and the Stairway To Hell SSD have identical files, but
the SSD's files sit at different sectors (the capture has `$.!BOOT` at sector 143, the SSD at sector 2),
its disc title has been set to `RETURNOFJEDI`, and its cycle number is 6 rather than 39. The Stairway To
Hell Nevryon and Colossus Chess SSDs are the same.

So the archive images are mostly re-mastered copies, with the files written out again by some tool,
rather than dumps of the original discs. No disc fingerprint will ever match those, and it shouldn't try:
that's exactly the `*COMPACT` case, and it belongs to the file-level matching, not the key.

An exact key over the set of files (names, addresses and contents) doesn't help much either: 72
cross-source matches rather than 64, because the near misses usually differ in a small file such as
`!BOOT`. Linking the archives together is going to be a similarity job.

## What the fingerprint does buy

The 7,696 distinct files collapse to 7,365 disc keys. Most of that is repeat captures: the HFE mirror's
1,985 files are 1,661 distinct discs, because the same disc has often been captured more than once, and
separate reads of the same disc agree, including reads of one disc taken in a 40-track drive and an
80-track drive.

## Protection, and a rule that had to go

The first draft of the flux path kept only sectors whose header named the track they were read from. On
the HFE mirror:

| Wrong-track sectors on side 0 | Captures |
| ----------------------------- | -------: |
| none                          |    1,537 |
| 1 to 10                       |       96 |
| 11 to 100                     |      112 |
| over 100                      |      240 |

The captures with hundreds are the interesting ones. Here's what jsbeeb decodes from an Exile capture:

```
physical  0: track 0,   sectors 0..9
physical  4: track 200, sectors 100..109
physical 10: track 197, sectors 103..112
physical 20: track 192, sectors 108..117
physical 40: track 182, sectors 118..127
```

Superior's protection renumbers every track after track 0, and the game lives on those tracks. The rule
threw all of it away and kept track 0: a stub catalogue and a loader, which Exile and Repton Infinity
share byte for byte. So captures of Exile and Repton Infinity (four of them, including ones labelled
"Exile v1" and "Repton Infinity Game Disc Master") all got the same key. A key made of a publisher's boot
track is worse than no key at all.

The fix keeps every sector with good CRCs, whatever its header claims, and orders them by the track they
were read from first. Comparing the two rules over the whole HFE mirror:

- All 1,537 captures without wrong-track sectors keep exactly the same key.
- Under the old rule, 8 keys were shared by captures whose titles have no word in common, one of them the
  Exile and Repton Infinity group. Under the new rule there are 6, and all six are the same title written
  differently: E-Type and E Type, Fire Track and Firetrack, Q-Master and Q Master, ViewStore and View
  Store, The Dam Busters and Dambusters, and Cheat It Again Joe and its abbreviation, CIAJ Vol 1.
- The new rule splits 17 groups the old one merged. One is the Exile collision; some the mirror itself
  already labels as different variants (Revs against Revs 4 Tracks, Uridium variants 1 and 2). A few,
  such as the Arcadians and Hopper captures, decode to different data with the same drop counts, and we
  haven't worked out yet whether that's a real difference on the protected tracks or noise in the
  capture.

## Which track is which

Keeping renumbered sectors raised a second problem. To know which physical tracks to read, the
fingerprint has to decide whether a side is a 40-track disc read in an 80-track drive, and the obvious
test (do the headers on the even tracks give half their track number?) can't see through renumbering
either. A 40-track Exile captured in an 80-track drive was judged 80-track, so its odd tracks, which only
hold ghosts of their neighbours, went into the key, and it stopped matching the same disc captured in a
40-track drive.

Looking for ghosts instead (odd tracks whose sectors are all copies of an even neighbour's) fixes that
case but breaks others: some discs legitimately repeat a track, so a few 40-track drive captures got
judged double-stepped and lost half their tracks. What works is a combination. A capture with nothing
past physical track 50 came from a 40-track drive and every track is real; otherwise the side is 40-track
if either the headers say so or the odd tracks are only ghosts. Against the header test alone, that
splits nothing and merges exactly two groups: the two captures of Exile v1 and the two of Exile v2.

## Trailing fill

Across 5,823 sides of sector images, the sectors trimmed off the end were `&E5` on 3,978 sides and `&00`
on 167. Any other repeated byte turned up on 7 sides in total (`&30`, `&29`, `&F0`, `&20`, `&6C`, `&0F`),
and a run of spaces or zeros at the end of a file could just as easily be real data. So trimming stays
limited to `&00` and `&E5`.

## Side keys

Only 64 images are double-sided (one of them has a second side that trims to nothing), and 11 of their
side keys also turn up on another disc. All eleven look like the same title, so the `ambiguous` record
for shared side keys will be rare, but it isn't imaginary.

## MAME

32 of the 326 images in MAME's BBC disc list match a corpus image by whole-file SHA-1 (23 Stairway To
Hell images and 10 bbcmicro.co.uk ones, one of them in both). MAME's list says it was compiled from the
Stairway To Hell archive and that none of its images are protected, and most of them no longer match what
the archive holds today. Its value to the registry is its short names and parent/clone structure rather
than its hashes.

## A look at Exile

Across our own two mirrors, Exile falls into families quite naturally:

- The original protected discs, captured as v1 and v2, a review copy and others. Each now gets a key
  covering the whole disc, and the two captures of v1 agree, as do the two of v2.
- A plain DFS version (the mirror calls it v3), with three copies. Two are captures of the same disc, one
  in a 40-track drive and one in an 80-track drive, and they agree. The third, reconstructed from an FSD
  dump, differs only in the catalogue's cycle number (49 against 17): that disc had been written to at
  some point.
- The Stairway To Hell `Superior/Exile.ssd`, a deprotected copy with a loader file of its own.
- Several cheat and editor discs from Stairway To Hell's `Cheats` folder, which share `EXILEL`, `EXEDIT`
  and `MAPPER` with each other and not with the game discs.

Shared files find those families without any help, which is encouraging for the clustering step. Saying
which one is the original, which is a crack and which is a modified version is the part that needs
judgement: it means reading loaders and diffs, not just comparing hashes.

---

This write-up was drafted by Claude (an LLM) with Matt, from experiments run with the tools in
`tools/registry/`.

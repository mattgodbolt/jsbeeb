# Media registry: first findings from the archive

These are the results of running a prototype of the fingerprint from the
[media registry proposal](media-registry-proposal.md) over every disc image we could lay hands on. The
tools are in `tools/registry/` (see its README), and everything here can be rerun from them.

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

Out of 7,367 distinct disc keys, only 64 turn up in more than one source. We'd expected a lot more, so
we looked at the near misses: captures whose files are byte for byte the same as an archive SSD's, but
whose keys differ. There are 88 of those, and the three we looked at closely were all the same story. The Return of
the Jedi capture and the Stairway To Hell SSD have identical files, but the SSD's files sit at different
sectors (the capture has `$.!BOOT` at sector 143, the SSD at sector 2), its disc title has been set to
`RETURNOFJEDI`, and its cycle number is 6 rather than 39. Nevryon and Colossus Chess are the same.

So the archive images are mostly re-mastered copies, with the files written out again by some tool,
rather than dumps of the original discs. No disc fingerprint will ever match those, and it shouldn't try:
that's exactly the `*COMPACT` case, and it belongs to the file-level matching, not the key.

An exact key over the set of files (names, addresses and contents) doesn't help much either: 72
cross-source matches rather than 64, because the near misses usually differ in a small file such as
`!BOOT`. Linking the archives together is going to be a similarity job.

## What the fingerprint does buy

The 7,696 distinct files collapse to 7,367 disc keys. Most of that is repeat captures: the HFE mirror's
1,985 files are 1,663 distinct discs, because the same disc has often been captured more than once, and
separate reads of the same disc agree. That's the fingerprint doing precisely its job.

## Protection, and a rule that had to go

The first draft of the flux path kept only sectors whose header named the track they were read from. On
the HFE mirror:

| Wrong-track sectors on side 0 | Captures |
| ----------------------------- | -------: |
| none                          |    1,542 |
| 1 to 10                       |       98 |
| 11 to 100                     |      114 |
| over 100                      |      231 |

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
share byte for byte. So Exile and Repton Infinity got the same key, twice over (the two games' captures,
and the "Exile v1" and "Repton Infinity Game Disc Master" pair). A key made of a publisher's boot track
is worse than no key at all.

The fix keeps every sector with good CRCs, whatever its header claims, and orders them by the track they
were read from first. Comparing the two rules over the whole HFE mirror:

- All 1,542 captures without wrong-track sectors kept exactly the same key.
- Under the old rule, 9 keys were shared by captures with unrelated-looking titles, including both
  Exile and Repton Infinity pairs. Under the new rule there are 6, and all six are spellings of one title
  ("Firetrack" and "Fire Track", "Mr. Ee" and "Mr Ee", "ViewStore" and "View Store").
- The new rule splits 17 groups the old one merged. Some are the Exile collisions; some the mirror
  itself already labels as different variants (Revs against Revs 4 Tracks, Uridium variants 1 and 2).
  A few, such as two Arcadians and three Hopper captures, decode to different amounts of data with the
  same drop counts, and we haven't worked out yet whether that's a real difference on the protected
  tracks or noise in the capture.

The proposal now uses the new rule.

## Trailing fill

Across 5,823 sides of sector images, the sectors trimmed off the end were `&E5` on 3,978 sides and `&00`
on 167. Any other repeated byte turned up on 7 sides in total (`&30`, `&29`, `&F0`, `&20`, `&6C`, `&0F`),
and a run of spaces or zeros at the end of a file could just as easily be real data. So trimming stays
limited to `&00` and `&E5`.

## Side keys

Only 64 images are double-sided, and only 3 side keys from them are shared by more than one disc. So the
`ambiguous` record for shared side keys will be rare, but it isn't imaginary.

## MAME

32 of the 326 images in MAME's BBC disc list match a corpus image by whole-file SHA-1: 23 from Stairway
To Hell and 10 from bbcmicro.co.uk. MAME's list is mostly its own selection of dumps, so its value to the
registry is its short names and parent/clone structure rather than its hashes.

## A look at Exile

Fourteen images across the three sources are some form of Exile, and they fall into families quite
naturally:

- The original protected discs: captures labelled v1, v2 and a review copy, among others. Under the new
  rule each gets a key covering the whole disc.
- A plain DFS version (one capture is labelled v3), captured three times. Two of the three captures agree; the third has identical files
  and a different key, which we haven't looked into yet.
- The Stairway To Hell `Superior/Exile.ssd` and bbcmicro.co.uk's 64K version share three files byte for
  byte, but have different load addresses (`&31200` against `&1200`) and a different `ExileMC`, so one
  of them has been modified.
- Several cheat and editor discs from Stairway To Hell's `Cheats` folder, which share `EXILEL`, `EXEDIT`
  and `MAPPER` with each other and not with the game discs.

Shared files find those families without any help, which is encouraging for the clustering step. Saying
which one is the original, which is a crack and which is a modified version is the part that needs
judgement: it means reading loaders and diffs, not just comparing hashes.

---

This write-up was drafted by Claude (an LLM) with Matt, from experiments run with the tools in
`tools/registry/`.

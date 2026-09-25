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
| My NAS: FSD dumps            |    427 | the sector dumps many of the HFE reconstructions came from  |
| My NAS: tapes                |    474 | 209 UEFs and 265 CSWs                                       |
| My NAS: ADFS images          |     29 | mostly copies of a few discs from old emulator trees        |

That's 7,760 disc images in the main corpus, plus the dumps, tapes and ADFS images from my NAS, each of
which gets a study of its own. Only aggregate numbers from the bbcmicro.co.uk images appear here; nothing
about individual entries is published.

## Sector and flux paths

The proposal hashes sector images from their bytes and flux images by decoding them. As a check that the
two are really the same thing, every sector image in the corpus (5,775 of them) was also loaded by
jsbeeb, decoded through the flux path and trimmed. All 5,775 gave exactly the same bytes both ways.

## Matches across sources

| Disc keys found in          | Count |
| --------------------------- | ----: |
| bbcmicro.co.uk and STH      |    57 |
| bbcmicro.co.uk and HFE      |     4 |
| bbcmicro.co.uk, HFE and STH |     2 |
| HFE and STH                 |     1 |

Out of 7,365 distinct disc keys, only 64 turn up in more than one source.

For the captures that share files with an archive SSD, the reason is that the archive images are mostly
re-mastered copies, with the files written out again by some tool, rather than dumps of the original
discs. Of the 450 captures that share at least half their files (counting files of 512 bytes or more)
with a Stairway To Hell SSD, 398 have those files at different sectors on the SSD. Return of the Jedi is
typical: the capture has 11 files and the SSD 12, with an extra `$.LOAD` and a different `$.!BOOT`, the
files sit elsewhere (the capture's `$.!BOOT` is at sector 143, the SSD's at sector 2), the disc title has
become `RETURNOFJEDI`, and the cycle number is 6 rather than 39. No disc fingerprint will ever match
those, and it shouldn't try: that's the `*COMPACT` case, and it belongs to the file-level matching, not
the key.

Even the closest cases rarely match. 17 captures have exactly the same DFS files, names and contents, as
an archive image, 16 of them against a Stairway To Hell SSD, and still get a different key. Some match
more than one archive image, which makes 19 pairs. Of those, 11 have the files moved and a different
title or cycle number, like Colossus Chess (the capture has `$.G30` at sector 122, the SSD at sector 2),
and one more has the files moved but the same title and cycle. The other seven have the files in the same
place and differ in what's left over. Four Cheat It Again Joe pairs differ in whole sectors of free
space, plus a byte or two of the catalogue, which looks like old data on a reused disc. Three captures of
The Hobbit differ from the archive's SSD in the catalogue (for one of them, the SSD's cycle number is 0
and the capture's 151) and in a few sectors of leftovers.

An exact key over the set of files (names, addresses and contents) doesn't help much either: 73
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
captures, and once for the images labelled "Exile v1" and "Repton Infinity Game Disc Master".

The fix keeps every sector with good CRCs, whatever its header claims, and orders them by the track they
were read from first. Comparing the first draft with the proposal (both its track rule and its pitch
test, below) over the whole HFE mirror:

- The 1,542 captures with no wrong-track sectors keep the same key.
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

The rest cost us something. Three groups are near-identical copies that the proposal now keeps apart:
Hopper v1 against a reconstruction of it, which differ by one byte in each of three sectors; The Empire
Strikes Back, whose capture and reconstruction differ in one sector; and a Philosophers Quest pair that
differs in four. All three sit on the protected tracks with good CRCs, and in each pair one image is a
direct capture and the other was reconstructed from an FSD dump, so the difference may be in how the FSD
recorded those sectors rather than on the discs. Either way the registry has to link them with an alias
rather than a shared key. `split-diffs.js` prints all of this.

## Which track is which

Keeping renumbered sectors raised a second problem. To know which physical tracks to read, the
fingerprint has to decide whether a side is a 40-track disc read in an 80-track drive, and the obvious
test (do the headers on the even tracks give half their track number?) can't see through renumbering
either. The Exile captures above, taken in an 80-track drive, were judged 80-track, so their odd tracks,
which only hold ghosts of their neighbours, went into the key, and they stopped matching the copies
reconstructed from FSD dumps.

Looking for ghosts instead (odd tracks whose sectors are all copies of an even neighbour's) fixes that
case, but a disc can legitimately repeat a track, and a ghost test alone would call a 40-track drive's
capture of such a disc double-stepped and throw away half its tracks. So the proposal combines them. If
nothing past physical track 50 holds data, every track that does is taken as real, which covers captures
from 40-track drives and discs whose data stops early. Otherwise the side is 40-track if at least four
even tracks carry headers for half their number (and more of them than carry their own). Failing that,
it's 40-track if at least four even tracks hold data and fewer than a tenth as many odd tracks hold
anything but ghosts. Against the header test alone, six captures change key. Four are Superior discs
captured in an 80-track drive: the Exile v1 and v2 captures, which now match their reconstructions, and
two Repton Infinity captures. The other two (Replica 3 and a Genie Utilities reconstruction) are 80-track
discs whose data stops before track 40, with leftovers of a 40-track format further in; the header test
called them 40-track and threw away the real data on their odd tracks. No group of captures that agreed
under the header test is split.

## Trailing fill

Across 5,823 sides of sector images, the sectors trimmed off the end were `&E5` on 3,978 sides and `&00`
on 167. Any other repeated byte turned up on 7 sides in total (`&30`, `&29`, `&F0`, `&20`, `&6C`, `&0F`),
and a run of spaces or zeros at the end of a file could just as easily be real data. So for DFS discs,
trimming stays limited to `&00` and `&E5`.

ADFS is different. Of the 58 sides of the ADFS images from my NAS (surveyed with `fill-survey.js
--with-adfs`), 30 end in runs of `&5A`, `&47` or `&6C`, and the second sides of the Master Welcome disc
and of a blank L image are nothing but `&47`. Those aren't trimmed, so the two blank sides share a side
key. Whether fill should depend on the format, or be any repeated byte after all, is still open; these
images come from emulator trees, and may not say much about what real formatters left behind.

## Side keys

Only 64 images are double-sided (one of them has a second side that trims to nothing), and 11 of their
side keys also turn up on another disc. Ten of those are the same title; the eleventh is shared by two
unrelated discs, which is what the `ambiguous` record for shared side keys is for.

## MAME

32 of the 326 images in MAME's BBC disc list match a corpus image by whole-file SHA-1 (23 Stairway To
Hell images and 10 bbcmicro.co.uk ones, one of them in both). MAME's list says it was compiled from the
Stairway To Hell archive and that none of its images are protected, and most of them no longer match what
the archive holds today. Its value to the registry is its short names and parent/clone structure rather
than its hashes.

## Families from shared files

Since the keys can't join re-mastered copies, the next thing to try is what the proposal calls step 3:
grouping images by the files they share. `cluster.js` puts two discs in one family when the files they
share, by content, make up at least half of each by size. When they make up half of only the smaller one,
the bigger one contains the smaller, which is how compilations and menu discs show up.

Getting there took two fixes. Many protected discs catalogue nothing but a shared boot loader and keep
the software off the catalogue, so seven or eight unrelated educational titles all "shared" one
1,280-byte `!BOOT`; discs that catalogue less than 8K now take no part. And on a protected disc, the
fingerprint's byte stream holds the protection's sectors too, so reading the catalogue from it put every
file in the wrong place (the judges below caught this on Elite). Files are now read the way DFS addresses
them, by each sector's header, and a file lying over sectors that couldn't be read doesn't count.

With that, 5,341 of the 7,365 disc keys catalogue enough to take part. They form 515 families of more
than one disc, and 384 of those span more than one source, joining 1,052 discs where the keys alone
joined 64 groups. There are 690 `contains` relations, and the ones we looked at really are compilations:
a Blue Ribbon games disc containing Bananaman, the Superior Collection containing Airlift, Smash 7
containing Attack On Alpha Centauri.

Checked against the HFE mirror's own labels (the same title, and the same disc and side where the
manifest says which), the families make few false links, at least by the rough test of whether two titles
share a word: of 429 pairs of labelled captures in one family, 423 do. Of the other six, four are one
title written differently or abbreviated (Death Star and Deathstar, and Cheat It Again Joe as CIAJ), and
two look like genuine false links. Recall is the weak side: of 288 pairs with the same label, 135 end up
in one family. Of the 153 that don't, 88 share no file at all, most likely a different build of the same
title, and no file-level matching will ever join those; 10 more are joined by a `contains` relation
instead.

The threshold trades one against the other:

| Share needed | Discs in cross-source families | Same-label pairs together | Pairs with unrelated titles |
| -----------: | -----------------------------: | ------------------------: | --------------------------: |
|          0.3 |                          1,292 |                       151 |                          27 |
|          0.4 |                          1,176 |                       147 |                           8 |
|          0.5 |                          1,052 |                       135 |                           6 |
|          0.6 |                            922 |                       124 |                           4 |

So shared files find families with few false links, but they can't tell versions of a title apart from
different software, or join builds that share nothing, and that's left to the judging step.

## Judging the differences

To see whether an LLM can do the judging, `judge-sample.js` drew 18 pairs from our own two mirrors: six
pairs from within families, six `contains` relations and six pairs of captures with the same title that
share some files but weren't put in one family. Two LLM agents judged each pair independently, with
`inspect.js` (catalogues, hex dumps, byte diffs, a disassembler and a BASIC lister) and `diff-images.js`,
picking one category from the proposal's list and quoting the command output behind every claim. Each
judge took about eight minutes and 48 tool calls for all 18. The sample and both sets of verdicts are in
`tools/registry/pilot/`.

The two agreed on the category for 15 of the 18. The three they didn't agree on were the hard ones, and
in the first two, one judge's secondary tags included the other's category: a menu rewritten for BASIC I
(compatibility fix, or publisher revision?), a PIAS re-release whose only change to the game is one byte
in one screen (re-mastered, or a revision?), and a game whose loader had been reworked, which both marked
as low confidence. The evidence was checkable: for example, both cited the Plan B cheat disc poking
`NOP`s over the two `DEC` instructions at &3F74 and &3F82 that count down ammo and energy, and the
disassembler agrees.

The judges also found things the rest of the pipeline had missed. One pair the sampler called a
compilation wasn't one. The category list had nothing for another disc of the same set, or for one
release packaged as 40-track and 80-track discs, or for which way a `contains` relation runs; the
proposal now has all three. And one judge found every mission file on the protected Elite disc shifted by
one, which is how the catalogue-reading bug above came to light.

Eighteen pairs is a small sample, and neither judge booted anything. But the two agreed on 15 of the 18,
the three they split on were ambiguous anyway, and their evidence can be rerun. No person has judged the
same pairs to compare against.

## Sector dumps

Most of the HFE mirror's reconstructions were rebuilt from FSD sector dumps, and 427 of those dumps are
on my NAS, 425 of which parse. `fsd.js` reads them and computes the fingerprint straight from the dump,
and `fsd-study.js summary` prints the numbers here. Read directly, 350 of the 398 dumps that pair with a
reconstruction give exactly its key, and 34 more differ only because the reconstruction fills tracks the
dump could read no data from with `&E5` sectors. Of the rest, 12 match a different dump of the same
number instead, and two differ over one overlong read.

Of the three near-identical pairs above, only The Empire Strikes Back is an artefact. Its track 10
carries three sectors numbered 3 with different contents, the dump lists that track in a different order
from the disc, and keeping the first copy picks different data. Only three tracks in the 425 dumps that
parse have repeated IDs with different contents, but it means "keep the first one read" should become
something that doesn't depend on order. The Philosophers Quest pair really differs on the disc: the
dump's sectors on track 33 are a shifted copy of the game's own data, while the capture's hold something
found nowhere else, which looks like duplicator leftovers that vary from copy to copy. The Hopper pair
differs by three bytes that the dump reads cleanly, so the reconstruction is faithful to it, and we can't
yet say which copy is unusual.

Against captures of the same title, 139 of 201 reconstructions share a key. Most of the near misses
differ in the catalogue, which looks like discs that had been written to. Tracks the dump couldn't read
are the weak spot: four captures hold `&E5` there, but nothing in the dump says so, so a key computed
from a dump with unreadable tracks should be recorded as provisional.

## Tapes

`tape.js` decodes UEF and CSW images, and `tape-index.js` fingerprints 2,101 of them: 1,627 UEFs from our
Stairway To Hell mirror, and 209 UEFs and 265 CSWs from my NAS. jsbeeb has no CSW support, so the decoder
is new. The key is computed from the files and blocks the MOS would read, not from the container, and it
has to be: of the 132 titles we have as both UEF and CSW, the raw decoded bytes agree for one, because of
leader and dummy bytes, while the key agrees for 128. In the other four, one of the two images has a bad
or missing block.

2,100 images get a key, and they make 1,737 distinct tapes. All 186 keys shared between images join
images that aren't byte-identical, so a file hash alone would have found none of those matches, and no
two different titles share a key. Most tapes are plain MOS files, but the keys of 103 images include
blocks that aren't part of a complete file. In 93 of them that's protection numbering blocks in a way the
MOS wouldn't accept as a file, and the other ten have a file with a bad block or no last block. Those
blocks go into the key one by one; a key over complete files alone would have been just the loader. 151
images carry over 1K in formats of their own that the key can't see, and we couldn't make those bytes
agree between copies of one tape, so they stay out.

2,296 of the 8,130 distinct tape files of 512 bytes or more also turn up byte for byte on a disc, and 279
tapes have all their files on one disc image. So a tape can find a disc's record through the file-level
matching, not through the key.

## ADFS

The corpus has hardly any ADFS: two ADLs from bbcmicro.co.uk, and no HFE capture in the mirror has an
ADFS root directory. my NAS has 29 ADFS images, mostly copies of the same few discs kept in old emulator
trees (Master Welcome discs, the ARM Evaluation System, the Master 512 boot disc), and they make 10
distinct keys. Copies of one disc agree, and two versions of the Welcome disc don't, which is right,
though with byte-identical copies that's not much of a test. All nine of the distinct images jsbeeb will
load give the same bytes through the flux path.

One image is an ADFS L disc named `.ADF`, so the fingerprint now decides how an ADFS image's sides are
laid out by its size, not its name. And ARM Evaluation System discs 4 and 5 have the same second side,
753 sectors of real data followed by fill, so that side key belongs to two discs, which is the
`ambiguous` case again.

## Symbols on a real game

We tried anchors on Repton 2, using George Foot's public-domain disassembly
([gfoot/repton2disassembly](https://github.com/gfoot/repton2disassembly), under the Unlicense; nothing
from it is copied here). `anchors.js` reads the listing, works out every address a store could reach
(including the full reach of indexed stores), and picks anchors automatically: runs of whole
instructions, four to eight bytes, starting at a routine's entry point, that no store it can resolve
touches, that contain no run of `NOP`s and that appear only once in the region. It chose seven anchors
for the main code and two each for two small regions. `anchors-run.js` then booted the game headless and
checked the anchors every 20 ms for five minutes of emulated time, playing with random keys.

On our reference capture the main region's anchors matched at 22.00 s, 20 ms before the code was
completely in place, never earlier, and stayed matched through play although over 8,000 bytes of the
region changed. In an earlier run, with slightly different rules for choosing anchors, five other copies
of the same build behaved the same. Repton 1 and Repton 3 never matched a single anchor. An earlier
build, which lacks a few routines, was rejected, but only because one of the seven anchors happened to
sit on one of them. A cheat disc, whose pokes had landed on runs of `NOP`s when those were allowed as
anchors, now keeps its labels.

So on Repton 2, at least, anchors are cheap and chosen almost entirely by a tool. What stayed manual was
naming the regions and leaving out the part of the listing that's the disassembler's own loader. To rerun
it from the jsbeeb root:

```sh
git clone https://github.com/gfoot/repton2disassembly r2dis    # repton2.s, at c5fed37
node tools/registry/anchors.js r2dis/repton2.s --name repton2-disc --exclude-section 0x70a0 \
    --region 0x0d00=main --region 0x0380=music --region 0x0880=page8 --out r2set.json
node tools/registry/anchors-run.js r2set.json .registry-corpus/hfe/64D80D49.hfe \
    --listing r2dis/repton2.s --exclude-section 0x70a0 --seconds 300
```

## Booting the discs

All but two of the 7,365 distinct disc keys (the two ADLs) were booted headless in jsbeeb, once as a
Model B with DFS 1.2 and once as a Master, holding SHIFT through power-on as the web page does, and left
for 30 emulated seconds. That's long enough for most: between 20 and 30 seconds, 264 discs on the B and
246 on the Master change between booted and not, but most of those spend their time in the MOS, and only
39 and 34 go between booted and a clear failure. `boot-survey.js` records where the CPU is running, what
the VDU printed and what's on the screen (reading bitmap modes by matching the MOS font), and
`boot-survey-analyse.js` prints the numbers. The whole run took about two and a half hours on a busy
machine.

A disc counts as booted when it ends waiting for a key somewhere other than a BASIC prompt, or running
code from RAM or BASIC. On that measure 87.6% boot on the B and 83.8% on the Master. Another 7% on each
end up running mostly in the MOS, which on the screens we looked at meant a title page polling for a key,
but we can't be sure of all of them. Our HFE captures boot least often (74.4% on the B and 64.8% on the
Master), which could be their protection or gaps in jsbeeb's disc emulation; the survey can't tell which.
An error message isn't a failure on its own: 231 boots on the B printed one and carried on, from loaders
that error deliberately and recover.

307 discs boot only on the B and 62 only on the Master. Those are candidates for `requires`, but not the
answer. A quarter of the Master-only discs are Electron releases, and some of the B-only ones look like
gaps in jsbeeb's Master disc emulation rather than real incompatibilities (Holed Out sits at its own
"Master version loading" message). Our capture notes name a machine for ten discs; the survey agrees on
five, can't tell on four, and disagrees on one (Tank Attack). 323 discs boot on neither model, but most
have boot option 0, so SHIFT+BREAK has nothing to run. The 113 that should autoboot and don't are the
place to start a jsbeeb compatibility list.

The screen is a good way to recognise a disc. On 69% of the discs that booted, a word from the disc's
known title appears on screen, against 3% for a different disc's title. Where the catalogue title is
blank or junk, the screen still names the disc 63% of the time.

## A look at Exile

Across our own two mirrors, Exile falls into families quite naturally:

- The original protected discs: v1 and v2, each captured and also reconstructed from an FSD dump, a
  review copy, and others. Each now gets a key covering the whole disc, and the capture and the
  reconstruction of v1 agree, as do those of v2.
- A plain DFS version (the mirror calls it v3), with three copies. Two are the two sides of one
  dual-format disc, a 40-track side and an 80-track side holding the same files, and they agree because
  the 80-track side's extra tracks trim away. The third, reconstructed from an FSD dump, differs only in
  the catalogue's cycle number (49 against 17), which looks like a disc that had been written to at some
  point.
- The Stairway To Hell `Superior/Exile.ssd`, a deprotected copy with a loader file of its own.
- Several cheat and editor discs from Stairway To Hell's `Cheats` folder, which share `EXILEL`, `EXEDIT`
  and `MAPPER` with each other and not with the game discs.

Shared files find those families without any help. Saying which one is the original, which is a crack and
which is a modified version is the part that needs judgement.

## What this changes in the proposal

- The flux path keeps sectors whose headers claim another track, orders by the track they were read from,
  and decides 40 or 80 tracks from three signs, not one.
- Trailing fill on DFS discs is only `&00` and `&E5` (ADFS is still open), and ADFS images are laid out
  by size, not by name.
- FSD sector dumps are a fingerprint input, with provisional keys where a track couldn't be read.
- Tapes have a key of their own, from the blocks the MOS would read.
- File-level matching reads catalogues by sector address and ignores discs that catalogue only a loader;
  it's what links archives, and it finds compilations as `contains` relations.
- The judging categories gained another disc of the same set, 40- or 80-track packaging, and a direction
  for `contains`.
- Anchors avoid `NOP` runs and come in smaller regions with a minimum count.
- Open: what to keep when a track repeats a sector ID with different contents, and whether duplicator
  leftovers should split copies.

---

This write-up was drafted by Claude (an LLM) with Matt, from experiments run with the tools in
`tools/registry/`.

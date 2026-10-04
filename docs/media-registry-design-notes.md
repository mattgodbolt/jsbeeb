# Media registry: design notes

The reasons behind the choices in the [media registry proposal](media-registry-proposal.md), and the
other projects it borrows from. The numbers behind them are in [the
findings](media-registry-findings.md).

## Goals

jsbeeb can load a disc from pretty much anywhere, but once it's loaded we know very little about it. Some
sources tell us a title and a publisher; the Bitshifters manifest also tells us which machine a demo
needs. For everything else we have a pile of bytes. Issue
[#107](https://github.com/mattgodbolt/jsbeeb/issues/107) has been open since 2016 asking to show
annotated source in the debugger, [#748](https://github.com/mattgodbolt/jsbeeb/issues/748) asks for key
remapping inside the emulator (ideally remembered per disc), and mobile support needs to know which keys
a game actually uses before it can put a joystick on the screen. All of those need the same first step:
working out what software we've just loaded, and finding out things about it.

What we want from the registry:

- The same disc should find the same record whatever format it arrives in: an SSD, a DSD, an ADFS image,
  a flux capture in HFE, or any of those in a zip. ADFS discs matter as much as DFS ones.
- Records should be static JSON, easy to mirror and archive, and able to grow. We'll find licences, links
  and control mappings long after a record is first written, and adding them shouldn't mean bumping a
  format version.
- Games come in versions, cracks, fixes and repackagings. The instructions and keys are usually the same
  across all of them, but something like the addresses in the running code can change with even a minor
  patch, so a version needs to be able to override bits of what it inherits.
- Licensing has to be explicit. Every bit of third-party content says where it came from and under what
  terms, and the registry never includes something it has no right to.
- The records don't hold disc images, and the registry isn't trying to replace the archives that already
  catalogue the software. A record links to wherever an image lives, which can be one of the archives or
  one of our own mirrors on bbc.xania.org.
- It should be easy for other emulators to use too.

## Prior art

Plenty of other projects have solved bits of this already, and the design borrows from them freely.

[MAME's software lists](https://github.com/mamedev/mame/tree/master/hash) (`bbcb_flop.xml` and friends,
CC0) give each title a short name, list the CRC32 and SHA-1 of each image, and have parent and clone
relations. They hash whole files, so the same software at two image lengths ends up with two hashes.
[TOSEC](https://www.tosecdev.org/) also hashes whole files and puts the identity in a naming convention;
its flags (`[a]` alternate, `[cr]` cracked, `[h]` hacked, `[!]` verified) are a pretty good starting
vocabulary for saying how one copy differs from another.

The closest thing to what we want is the ZX Spectrum's ZXDB (and the ZXInfo API in front of it): a stable
ID per title, lots of file hashes pointing at it with a note of where each came from, typed relations
like `duplicateOf` and `modificationOf`, and structured controls. RetroAchievements does something
similar, mapping many labelled hashes to one game, and has the useful warning that you hash the image as
loaded, not after the game has written to it. ScummVM hashes named files inside a game rather than
containers, and keeps a table of renamed IDs. Homebrew's formula API is a static JSON site built from
git, where renames and aliases are followed by the client, so the server doesn't need to do anything
clever. And js-dos has per-game mobile layouts: grids of on-screen keys plus a virtual joystick.

Closer to home:

- beebjit (Chris Evans) has a disc fingerprint. Per side, it takes a CRC32 of each track's good sectors
  (data mark and data, in the order they sit on the track), then a CRC32 of those track CRCs. Gaps and
  bad sectors don't count, so a sector image and a flux capture agree as long as the sectors are laid out
  in the same order. jsbeeb's HFE mirror (`tools/mirror-bbcdiscs.js`) names the captures from the
  catalogue by these per-side CRCs. Our fingerprint is the same idea with a longer hash, and a sector
  order that doesn't depend on how the disc was formatted.
- Clock Signal's Acorn analyser (Thomas Harte) guesses the machine and how to boot from the content
  alone: the catalogue's boot option, load addresses that need a second processor, which I/O addresses
  the code pokes. That's a good fallback when there's no record at all.
- Robert Smallshire's [Beebium](https://github.com/rob-smallshire/beebium) has per-game key mapping files
  that name the action each BBC key performs (`"keyName": "Caps Lock", "action": "Rotate Left"`), and
  Robert has said he's keen on an emulator-agnostic way of describing game actions. The controls part of
  the registry should be worked out with him rather than separately.
- Rich Talbot-Watkins' [Baron](https://github.com/waitingforvsync/baron) assembler writes every resolved
  symbol to a JSON file with `--symbols`, which a converter can turn into a symbol set. Rich was in the
  original #107 discussion too, and we've been talking with him about source formats since.
- [bbcmicro.co.uk](https://bbcmicro.co.uk) already launches jsbeeb from its game pages, passing a model
  and `KEY.` remaps in the URL, and its database has per-game keys and a platform. See [the licensing
  rules](media-registry-proposal.md#licensing) before reaching for any of it.

## One key namespace

I don't see why each kind of hash would need its own directory: if two kinds of key could collide, the
hash is a bad hash. If we ever change how a key is computed, the new keys just become more aliases and
the old ones keep working.

The file hash is there because any tool can compute it without decoding a disc, and it lines up with the
hash lists other projects publish. beebjit's CRC is only 32 bits a side, which is a bit short to share a
namespace with thousands of other keys, so it's a plain field. Our HFE mirror's manifest already maps
those CRCs to discs, so anything keyed on them can be translated in bulk.

## What the fingerprint is for

The fingerprint's job is quite narrow: to recognise the same dump of a disc whatever container it's in.
Recognising two discs that are functionally the same but laid out differently (one of them `*COMPACT`ed,
say) is a job for the [file-level matching](#finding-aliases), not for the key. The findings bear this
out: archive SSDs are mostly re-mastered copies, so almost no capture shares a key with one, while files
link 1,052 discs across sources.

It works from sector bytes, not a disc model, which should make it pretty easy for any emulator to
implement, and it knows next to nothing about filesystems.

## Trimming

Baron, for one, truncates its SSDs after the last used sector, and plenty of tools pad them to 200K, so
the trimming is what lets those agree. Only fill is dropped, so a reused disc with old data past its last
file keeps it.

On DFS discs, `&E5` (what a format leaves behind) and `&00` (padding) are almost all the corpus shows;
the handful of other runs could just as easily be the end of a file. ADFS formatters left `&5A`, `&47`,
`&F6` and others behind, and a blank second side of one of those would otherwise stop a capture ever
matching an image of its first side, so on ADFS any repeated byte counts. Looking for the root
directory's "Hugo" or "Nick" is the one bit of filesystem knowledge the fingerprint needs. A DFS disc
with those bytes at `&201`, or a reused ADFS disc re-catalogued as DFS, would be trimmed harder than it
should, which only costs a key that differs from other copies. The
[findings](media-registry-findings.md#trailing-fill) have the counts, including scarybeasts' Master
Compact captures.

## Reading flux captures

The rules as the prototype implements them:

- **Pitch**, counting only sectors with good header and data CRCs. If nothing past physical track 50
  holds data, every track is read. Otherwise the side is 40-track if at least four even tracks other than
  track 0 have a sector whose header gives half their physical track number, and more even tracks do that
  than give their own; or, failing that, if at least four even tracks hold data and fewer than a tenth as
  many odd tracks hold any sector that isn't a copy of an even neighbour's. An odd track that read
  nothing counts as a copy, so an 80-track capture whose odd tracks all failed to read is taken as
  40-track; that's a bad dump anyway.
- **Order**: by the track read from, then header track, then header sector ID. Where all three repeat,
  identical copies count once and different contents are each kept once in ascending byte order, a sector
  sorting before a longer one it is the start of.
- **Sizes**: the concatenation is trimmed as 256-byte blocks, whatever sizes the sectors were.

Why each of those:

**Pitch.** A 40-track disc read in an 80-track drive has its data on the even tracks, and the odd tracks
are either empty or ghosts of their neighbours. Neither of the two signs is enough alone: protected discs
renumber their tracks, so the headers don't always give half the physical track, and some discs
legitimately repeat a track, so an odd track holding a copy isn't proof either. Captures with nothing
past track 50 are taken as they are, which covers 40-track drives and discs whose data stops early.
jsbeeb's `sniffSurfaceLayout` does something like the header test, but once per disc, and a flippy disc
can have a different pitch on each side. The findings list the captures the combined rule changes against
the header test alone.

**Bad CRCs.** Weak sectors read differently on every capture, and two captures of the same original need
to agree, so sectors with bad CRCs are dropped.

**Sectors claiming another track.** An earlier draft dropped them and got this badly wrong: Superior's
protection renumbers every track after track 0 (physical track 4 says it's track 200, and so on down), so
the rule threw away the whole game and kept only the boot track. Exile and Repton Infinity share that
boot track byte for byte, and ended up with the same key. For an unprotected disc the headers match
anyway, so the order is the same as an SSD's and so are the bytes. The price is that a capture of a
protected disc no longer matches an SSD made from it, because the SSD can't hold the renumbered sectors.
That hardly ever happened anyway: of the captures that share most of their files with a Stairway To Hell
SSD, nearly nine in ten have those files at different sectors, so the SSDs are mostly re-mastered, not
dumped.

**Repeated sector IDs.** Keeping the first copy read made the key depend on the order the copies came in,
which is how a capture of The Empire Strikes Back and the FSD dump behind its reconstruction got
different keys: the dump lists the track in a different order from the disc. On some protected discs the
copies are the protection, so keeping one, or none, would let discs that differ only there share a key.
Keeping every different copy in byte order costs at worst an alias when two captures read different
copies, and a wrong match is worse than a missed one. Counting copies wouldn't work either: that capture
and that dump hold the copies different numbers of times.

**Incomplete sides.** The data is concatenated without positions, so if a sector is missing or unreadable
part way through (a damaged track, say), everything after it shifts, and the capture gets a key of its
own. That's a bad dump, which the registry handles as an alias like any other variant.

**Naming mirrors.** The HFE mirror doesn't use fingerprints to name its reconstructed captures, because
it needs one name per file, which is the file hash's job. A mirror names files, and the registry
recognises discs.

## FSD dumps

An FSD records each sector's header, data and read status, so it can be fingerprinted without rebuilding
a flux image first. A dump can mark a sector as a CRC error because it read past the sector's real end,
and a good CRC after a shorter length says the shorter read was right. A track the dump could only read
headers from is the weak spot: some captures hold `&E5` there, but nothing in the dump says so, which is
why those keys are provisional.

The rule: every track in the dump is read, with no pitch test, and sectors are ordered as a flux
capture's are, with the dumped track in place of the physical one. A sector counts when it was read
cleanly, or when its data had a CRC error but the bytes it overran hold a good CRC after a shorter
power-of-two length, and then only that length counts. A track the dump could only read headers from
contributes nothing, and the key is provisional: recorded, but never used to merge the dump with other
images.

## Side keys

Some side digests are shared by lots of unrelated discs (every blank formatted side looks the same), so a
side key can't be trusted just because it matches. Publishing it only when it's unambiguous, and turning
it into an `ambiguous` record when that changes, means a published key always resolves, and never to the
wrong title. A formatted but empty second side still has a catalogue on it, so a DSD with one gets a disc
key of its own, and finds the SSD's record through the side key.

## Tapes

Carrier, gaps, baud rate and how a container chunks things vary between captures of the same tape, so the
key is over the blocks the MOS would read. Protected tapes number their blocks in ways the MOS wouldn't
accept, and the loose-block records are how their content still gets into the key.

The rule, as `tools/registry/tape.js` implements it:

1. Decode the tape to bytes: UEF data chunks (`&0100` and `&0104`), or CSW pulses at 1200 baud.
2. Find MOS blocks: `&2A`, a name of up to ten characters and a zero, load and execution addresses, block
   number, length, flags and four spare bytes, a CRC-16 of those, then the data and its CRC.
3. Consecutive blocks with the same name, numbered up from 0 to one with bit 7 of its flags set, make a
   complete file if none has a bad CRC. A block with the same name and header as the last block of the
   most recent file may be a retry, even after it closed the file: a good copy replaces a bad held copy;
   a bad or identical copy of a good one is skipped; a good one with different data is a different block.
4. Hash records in tape order and cut to 128 bits. A complete file gives `&46`, its name and a zero, its
   load and execution addresses and length (32-bit little-endian), then its data. A good block outside a
   complete file gives `&42`, its name and a zero, its load and execution addresses, its block number
   (16-bit) and flags, its length (32-bit), then its data. A record identical to the one before it is
   left out.

## Record chains

Instructions and keys belong to a title, symbols to a version, and a crack that moves code around needs
to override just the symbols. A chain merged with JSON Merge Patch does that with no special cases, and
there are libraries for it in pretty much every language. Merge Patch replaces arrays wholesale, which is
why collections are objects keyed by a stable name: a version can change one action, or add one link,
without repeating everything else.

Redirects are only for slugs, because a hash key is already an alias with a parent; if two title slugs
are merged, the losing one becomes a redirect.

## Symbols

BBC games rewrite their own memory all the time. Code is decrypted and relocated as it loads, variables
sit in amongst the code, self-modifying code is everywhere, and the emulator has no idea when loading has
finished. So a symbol set can't just be pinned to a disc and shown, and it can't be checked by hashing
big ranges of memory either. Anchors are cheap to check (a handful of bytes each time the debugger shows
a region), and before the code has arrived they simply don't match, so we never need to know when loading
is done.

The anchor rules come from trying it on Repton 2 (the findings have the details). Stores that can reach
an anchor would make it fail while the game runs; runs of `NOP`s are where cheats poke. Choosing anchors
turned out to be mostly automatic: given a disassembly listing, a tool can work out every address a store
can reach, list the candidate runs and pick about one per 2K of code. What stayed manual was naming the
regions and noticing which parts of the listing weren't the game (a disassembler's own loader, say). A
big file makes a poor single region, since one build difference is only caught if an anchor happens to
sit on it, hence smaller regions with `minAnchors`.

The rules: an anchor is four to eight bytes of whole instructions starting at a routine's entry point; no
store whose target can be worked out may reach any of its bytes (counting the full reach of indexed
stores), except a copy, swap or load whose known range covers the whole region (below); it has no run of
two or more `NOP`s; and its bytes appear only once in the region. The debugger checks a region when it's
about to use it (showing the disassembly, stopping at a breakpoint set by name), and needs every anchor
to match and at least `minAnchors` (default and minimum 1) of them. A region without anchors is never
shown automatically, but can be picked by hand.

The project rebuilding Superior's PIPELINE byte for byte from source gave the format its second test, and
most of what follows answers its feedback. According to that feedback, the disc holds several programs
that take turns in the same memory: three loader stubs at `&0900` that differ in 6 of their `&D9`
bytes, a game, a level designer and a graphics editor, and a data file the game loads over its own load
image. Their notes say the game swaps `&0D00-&1CFF` with the screen while it loads that file, and that
its start-up code becomes a table of the level's objects once it has run.

### Format

A set is in the registry's own format, not an assembler's, because what the debugger needs is narrower
than any assembler's dump and those dumps change. Baron's, for one, puts labels and constants alike in
one JSON object per source file, so a consumer can't tell which numbers are addresses, and, as the
PIPELINE feedback points out, it doesn't say which section a label is in, so there's no load or run
range to tie it to. Converters from each assembler or disassembler sort that out once, and a build that
knows its own sections can emit a set directly. Each program, with what's always loaded along with it,
is its own set, so its globals (zero page variables, the tune in page 8) show only when that program is
there. Names are addresses only, since a constant shown as an address is the one thing a debugger would
get wrong; whether a name is code or data can be added later if a debugger finds a use for it, as new
fields can.

A region's names win over its set's globals at the same address because that's where code turns into
data: when the start-up code is overwritten, its region stops matching and the global naming the table
shows instead.

Sets live in the registry, not at a link elsewhere, so the build's checks and the index can't go stale
when someone else's file changes. That costs nothing extra, since a disassembly without a licence that
allows it is a link only and never a set anyway.

### Where to cut regions

Every anchor in a region has to match. Letting a region tolerate one failing anchor would let
near-identical overlays both match, and the PIPELINE stubs share most of their candidate anchors. When
an anchor fails while the code around it is still there, the region shows plain addresses for a while,
which is the safe direction. So the work is in cutting regions where memory changes, using what the
build or the listing already says. The code gives the bounds of its copies, swaps and loads (a block
copy's inline arguments, an `OSFILE` parameter block), and whoever cuts the regions picks the ones that
move a program: the copy that puts it in place, a swap that parks it. Cut at their bounds, those cover
whole regions and don't rule out anchors in them. Any other store, such as a level's data copied into a
table, still does:

- Cutting the game at `&0D00` and `&1D00`, the bounds of its swap, means only the swapped part loses its
  names while the data file loads; the routine doing the loading, outside that range, keeps them.
- Code that's overwritten once it has run is a region of its own, cut out of the region around it, with
  its anchors on the bytes that get overwritten (the other exception to the store rule), so its names go
  when it does.

Writes no static analysis sees (the filing system's workspace, copies through a computed pointer) can
still land on an anchor. The region then loses its names until the bytes come back, which is acceptable
during a disc load, and a person who notices can move the anchor or tell the chooser to avoid a range.
We don't record runs of the game to find these writes: anyone with the source or a listing should be able
to make a set without playing every part of the game, and a recorded run only covers what was played.
There's also no way to label code that's parked somewhere it can't run, such as the swapped part of the
game while it sits in screen memory; that would need a region with an offset, which isn't worth a field.

Overlays are told apart by an anchor on a byte where they differ. The chooser looks for those, and the
build checks that any two overlapping regions in the sets of one record chain have anchors that disagree
about some byte. On PIPELINE that covers the stubs, the game and the editors, which are separate sets
hanging off one version, and is easiest when one run of the chooser picks all of their anchors together.
So no two of the sets a disc's own records give can match at once, and the debugger needs no rule for
it. Anything else that matches twice is the user's choice; merging names that happen to agree isn't
worth its rules.

Anchors are read from the memory being looked at, which covers sideways banks and shadow RAM without a
field saying which bank a region is in, and works for a ROM whatever slot it's in. A breakpoint set by
name stops only if the name applies when it's hit (its region matches, or for a global, any region of
its set), so a breakpoint on the game's main loop doesn't stop when the level designer runs at that
address. The price is that a write that breaks an anchor also quietly disarms the breakpoint; a
breakpoint set by address always stops, for anyone who'd rather have that.

The chooser takes a neutral input: each section's bytes at its run address, its instruction starts and
labels, and the stores whose targets the assembler or disassembler could work out, plus the cuts and the
ranges to avoid. The prototype reads a py8dis listing; BeebAsm and Baron builds would produce the same.

### Finding a set without a record

Symbol sets hang off version records, but the image's key doesn't always lead there. PIPELINE's
designers save to the game disc, so a copy that's been used has a new key and no record, although its
code hasn't changed; our corpus has one such copy, identical in every catalogued file and different in one
catalogue byte. Looking up a catalogued file's hash wouldn't help there, since on PIPELINE the catalogued
files are only the loader stubs, and those differ between copies while the code that matters is in
sectors the catalogue doesn't cover.

Since anchors check the code itself, a set can be found by its anchors. The build publishes every set's
regions and anchors in one index, and a debugger with nothing from the records checks memory against it.
That finds the set for any copy whose code is unchanged and where it was: a used disc, a crack that only
touched the loader, a compilation that loads the game as it was. It doesn't help where code has moved,
as it often has on a tape release. A match from the index is offered rather than shown, because the
index tries every set against any program, and one small region with a short anchor at a common address
could match something unrelated; a person can see at once whether the names fit. The index grows with
the registry, at a few dozen anchors of eight bytes or so per set, and it's fetched only when the
debugger wants names and the records gave none. Checking it reads every indexed region covering the
address being shown, a few thousand byte comparisons even if hundreds of sets cover it, which is nothing
next to drawing the view. Each index entry names the record that lists its set, so a set found this way
comes with that record's licence and provenance like any other.

## Licensing

CC0 for our own data lets every emulator take it, as MAME does with its software lists.

Disassemblies need particular care. Several published BBC disassemblies have no licence at all, and some
say outright that no reuse is permitted. Those are links only, unless and until their authors tell us
otherwise.

Instructions and screenshots have a copyright of their own. Which keys a game uses is a fact, so
`controls` records it along with where it came from, but the text of the instructions is content.

The detail behind the proposal's rules: permission to inline is recorded in the entry (a link to where it
was given, or when); disassemblies without a permissive licence or recorded permission are links only,
never symbol sets; MAME's software lists are CC0 and can be used directly; TOSEC's names and hashes are
factual data, used with credit; and any database without a stated licence is asked first and linked to
meanwhile. Whether we mirror a disc image is a separate decision about that image.

## Finding aliases

Most of the work of filling the registry is mechanical, with an LLM helping on the calls that need
judgement, and nothing gets published until a person has looked at it.

Clustering by shared files is what links archives, since the keys mostly don't. Small files and files of
one repeated byte are shared by unrelated discs, and many protected discs catalogue only a loader, which
is why those are left out. Files are read the way the filesystem addresses them, not from the
fingerprint's byte stream, which on a protected disc holds extra sectors. A crack differs by a few bytes
in a loader; a menu disc is the game's files plus some extras; 40- and 80-track copies share every file;
a tape and a disc of the same game share the main code.

The pipeline:

1. **Collect** each image's source, keys and decoded file list (names, addresses, lengths, a hash per
   file), reading files by sector address.
2. **Group** equal keys as aliases.
3. **Cluster** images whose shared files make up at least half of each, leaving out files under 512 bytes
   or of one repeated byte, and discs that catalogue less than 8K in the rest. When shared files make up
   half of only the smaller image, the bigger one `contains` it.
4. **Judge** each cluster with an LLM working through tools (a byte diff, the disassembler, a BASIC
   detokeniser, headless jsbeeb reading the title screen), putting each difference into one of: same
   dump, bad dump, remastered (the same files written out again by a tool), disc written to (a later
   write, a changed cycle number, leftover data), protection removed, trainer or cheat, menu or extras
   added, compilation (with which one contains which), another disc of the same set, 40- or 80-track
   packaging, compatibility fix, publisher revision, port, or different software.
5. **Review**: each cluster becomes a pull request of alias records with its evidence and a confidence
   level, and the records' provenance says they were proposed by automated analysis and then reviewed.

A judge's claims have to be checkable by a tool ("differs only in `$.LOADER`, at these bytes") so the
pipeline can check them again. The findings include a pilot: clustering over the whole corpus, and two
independent LLM judges on a sample of pairs.

The same pass can read keys off instruction screens, work out which machines each variant gets to a title
screen on, and list the images that don't work in jsbeeb at all. The findings' boot survey does the last
two for the whole corpus. What it gives for `requires` are candidates for a person to confirm, not
answers, because an Electron release or a gap in jsbeeb looks just like a machine requirement.

---

These notes were drafted by Claude (an LLM) with Matt, from a conversation about what's out there and
what jsbeeb needs. The survey of other projects was done by reading their code and documentation.

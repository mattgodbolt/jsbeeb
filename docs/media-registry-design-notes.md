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
  across all of them, but a version can need another machine or change a control, so it needs to be able
  to override bits of what it inherits.
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

Instructions and keys belong to a title, and a version or a copy overrides only what differs, such as the
machine it needs. A chain merged with JSON Merge Patch does that with no special cases, and there are
libraries for it in pretty much every language. Symbol sets aren't part of the chain at all
([why](#finding-sets-by-their-anchors)). Merge Patch replaces arrays wholesale, which is why collections
are objects keyed by a stable name: a version can change one action, or add one link, without repeating
everything else.

Redirects are only for slugs, because a hash key is already an alias with a parent; if two title slugs
are merged, the losing one becomes a redirect.

## Symbols

BBC games rewrite their own memory all the time. Code is decrypted and relocated as it loads, variables
sit in amongst the code, self-modifying code is everywhere, and the emulator has no idea when loading has
finished. So a symbol set can't just be pinned to a disc and shown, and it can't be checked by hashing
big ranges of memory either. Anchors are cheap to check (a handful of bytes each time the machine stops),
and before the code has arrived they simply don't match, so we never need to know when loading is done.
Since they check the code itself rather than the disc it came from, they're also how a set is
[found](#finding-sets-by-their-anchors).

The anchor rules come from trying it on Repton 2 (the findings have the details). Stores that can reach
an anchor would make it fail while the game runs; runs of `NOP`s are where cheats poke. Choosing anchors
turned out to be mostly automatic: given a disassembly listing, a tool can work out every address a store
can reach, list the candidate runs and pick about one per 2K of code. What stayed manual was naming the
regions and noticing which parts of the listing weren't the game (a disassembler's own loader, say). A
big file makes a poor single region, since one build difference is only caught if an anchor happens to
sit on it, hence smaller regions with `minAnchors`.

The rules: an anchor is four to eight bytes of whole instructions starting at a routine's entry point; no
store whose target can be worked out may reach any of its bytes (counting the full reach of indexed
stores); it has no run of two or more `NOP`s; and its bytes appear only once in the region. Each
exception is explained below: a copy, swap or load picked as moving the program, whose range covers the
whole region, doesn't count as a store; run-once code is anchored on the bytes that get overwritten; an
anchor that tells two overlays apart needn't start at a routine's entry; a region with no code, such as
an adventure's database, is anchored on data its interpreter never writes; and a ROM's anchors can sit
anywhere but `&FC00-&FEFF`. The debugger checks regions each time the machine stops and when a breakpoint
set by name is hit, and a region needs every anchor to match and at least `minAnchors` (default and
minimum 1) of them. A region without anchors is never shown automatically, but can be picked by hand.

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
PIPELINE feedback points out, it doesn't say which section a label is in, so there's no load or run range
to tie it to. Converters from each assembler or disassembler sort that out once, and a build that knows
its own sections can emit a set directly. Each program, with what's always loaded along with it, is its
own set, so its globals (zero page variables, the tune in page 8) name operands only in that program's
code. Names are addresses only, since a constant shown as an address is the one thing a debugger would
get wrong; whether a name is code or data can be added later if a debugger finds a use for it, as new
fields can.

A set carries its own `title`, `licence` and `source` because no record lists it. What a set names is
code, and the same code turns up under many keys (a copy that's been written to, a crack, a compilation,
a cheat disc, a tape that loads it at the same address), while one disc can hold code that has nothing to
do with its title, such as a publisher's loader. `madeFrom` says which images a set was made from, for
whoever checks it later, and is never used to find it.

A region's names win over its set's globals at the same address because that's where code turns into
data: when the start-up code is overwritten, its region stops matching and the global naming the table
shows instead. An instruction's own set comes before any other, since a loader left in memory can still
match over a buffer the running program has taken for itself.

Globals belong to the code that uses them, rather than showing whenever a region of their set matches,
because a loader often stays where it was after jumping to what it loaded. According to the PIPELINE
feedback, the stub at `&0900` that loads the graphics editor stays intact while the editor runs, so its
region keeps matching, and its zero page names `&70` and `&72` differently from the editor's. Naming an
instruction's operands from its own set gives the stub's code the stub's names and the editor's code the
editor's, whichever of them is running. Choosing by the running program instead (the PC, or a return
address on the stack when the PC is in a ROM) would name the code on screen after whatever holds the PC,
and if the loader called what it loaded and the stack was never reset, a scan of the stack could still
meet the loader's own return address. Code outside every matching region, such as a game no set covers,
gets no set's globals but the MOS's (below): whatever it does with zero page, it isn't any set's program
doing it. The same goes for a short routine a program copies somewhere no anchor survives, such as page
1, unless its set gives it a region it can match in. An address shown on its own has no instruction to go
by, so it takes a global only when one set with a matching region names it, which labels the object table
once the start-up code has gone and leaves the stub's and the editor's zero page bare. A region picked by
hand counts as matching.

The MOS's globals are the exception, because every program uses the MOS's addresses as well as its own.
Under the rule above, a game's `STA &020E` wouldn't read `WRCHV`, since that name belongs to the MOS's
set and the instruction to the game's. So a MOS's set is marked as a system set, and only a MOS's can be
one; the chooser checks each MOS version's anchors against the other versions, which keeps them to one at
a time. A system set lends its globals (vectors, OS variables, workspace) to all code, after everything
else: the instruction's own set's regions and globals, then other sets' matching regions. That names the
OS's addresses everywhere, including in the most common case of all, a game no set covers. A game that
has taken over the machine and reuses OS workspace for its own variables gets the OS's names for them
unless its own set names those addresses, and even a name that's wrong for the game says what the address
was. System globals apply while any region of their set matches, so the names are those of the MOS that's
running. For an address shown on its own they come last too, after a global that only one other set
names.

Sets live in the registry, not at a link elsewhere, so the build's checks and the index can't go stale
when someone else's file changes. A linked set is no exception: its regions and anchors are in the
registry, and its names are pinned to one version of the author's file ([below](#linked-sets)).

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
still land on an anchor. The region then loses its names, and its code its set's globals, until the bytes
come back, which is acceptable during a disc load, and a person who notices can move the anchor or tell
the chooser to avoid a range. We don't record runs of the game to find these writes: anyone with the
source or a listing should be able to make a set without playing every part of the game, and a recorded
run only covers what was played. There's also no way to label code that's parked somewhere it can't run,
such as the swapped part of the game while it sits in screen memory; that would need a region with an
offset, which isn't worth a field.

Overlays are told apart by an anchor on a byte where they differ. On PIPELINE the stubs, the game and
the editors are separate sets, and one run of the chooser picks all of their anchors together, checking
each region's anchors against the others' bytes. Merging names that happen to agree isn't worth its
rules. The chooser warns when a single candidate is all that tells two overlays apart, since a later
change to the store rule could quietly take it away; according to the feedback, the PIPELINE stubs differ
at only one labelled instruction, `read_whole_run` at `&0916`.

Sets made separately are told apart by the corpus check ([below](#code-that-turns-up-elsewhere)). The
chooser tests every candidate anchor against every title's files at the same address, and runs every
region in the index over the new program's own bytes at its run address, which is the debugger's per-stop
check, so an earlier set that would match the new program shows up too. The pull request that adds a set
carries the report for the reviewer to read. That's the trade: the build doesn't prove two sets apart, a
person reading the report does. The build has no images, only anchors, so a proof would need every pair
of overlapping regions to anchor a common address where they differ, which means extra anchors on every
earlier set a new one overlaps, and that cost grows with the registry. The corpus check costs the same
however big the registry gets, and tries anchors against real code rather than against other sets'
anchors, and the measurement shows what it finds: across the corpus, the 2,228 matches between titles
were all in files at least 10% alike, nearly all at 90% or more, and all the same code or data. Its limit
is the corpus's: files sit at their load addresses, so code that's relocated or decrypted as it loads, or
that no catalogued file holds, isn't looked at, nor is a match split across two files that load together,
and a report with nothing in it says only that nothing at those addresses matched. The build checks what
it can without images, set by set: the schema and licence, anchor lengths, `minAnchors`, anchors inside
their regions, none in `&FC00-&FEFF`, and `system` only on a set in the registry's list of MOS sets. Two
sets that slip past the corpus check fall to the debugger's rule: when regions of two sets match at the
same address, it shows neither and offers the choice, as it does when a region picked by hand clashes
with one that matches. The list of MOS sets is kept by hand, since no address range tells a MOS from
other ROMs (the Atom's BASIC, floating-point and DOS ROMs sit at `&C000-&EFFF`, below its kernel), and a
change to it needs a maintainer's review, which the repository can require of that one file; the
debugger's rule wouldn't catch a set wrongly on it.

A breakpoint set by name stops only if the name applies when it's hit (its region matches, or for a
global, any region of its set does), so a breakpoint on the game's main loop doesn't stop when the level
designer runs at that address. The price is that a write that breaks an anchor also quietly disarms the
breakpoint; a breakpoint set by address always stops, for anyone who'd rather have that. A breakpoint on
a global can also stop for another program's use of that address while a region of its set is still in
memory, which for a breakpoint is the safer mistake: a program's variables are also written by code no
set covers, such as the filing system filling a buffer.

The chooser takes a neutral input: each section's bytes at its run address, its instruction starts and
labels, and the stores whose targets the assembler or disassembler could work out, plus the cuts and the
ranges to avoid. The prototype reads a py8dis listing; BeebAsm and Baron builds would produce the same.

### Finding sets by their anchors

Records don't list symbol sets, because an image's key is the wrong thing to find them by. A key names
one dump of one disc, while the code a set names turns up under many keys. PIPELINE's level designer and
its Mission Generator (a BASIC program, so no set) save to the game disc, so a copy that's been used has
a new key, and the same code is in a crack that left it where it was, a compilation that loads the game
as it was, a cheat disc, or a tape that loads it at the same address. Anchors check the code itself, so
finding sets by them is one path for all of those, the disc we know included. It doesn't help where code
has moved, as it often has on a tape release; a set made for that copy is then found the same way.

Looking up a catalogued file's hash wouldn't do as well. Our corpus has a PIPELINE copy that differs from
a known capture only in a catalogue byte, the count of writes to it, and its stubs match the capture's,
so that lookup would find it; but on PIPELINE the catalogued files are only the loader stubs, which
differ between the copies we have, while the code that matters is in sectors the catalogue doesn't cover.
Anchors cope with both cases in the PIPELINE feedback. A used copy keeps whatever code its saves haven't
covered. DFS can't see the sectors the catalogue doesn't cover, so a save goes after the last catalogued
file, which is just short of the game's code: according to the feedback, the first saved level fits, a
second lands on the game's first sectors, and a single mission or graphics set saved from the Mission
Generator covers some or all of the game, which then no longer starts. The regions anchored in what was
overwritten stop matching, which is right, and the rest still match. And Stairway To Hell's PIPELINE is a
crack that left the code where it was: its game and graphics editor are byte for byte the originals, and
the level designer's three changed bytes are mid-routine, away from any anchor, so all three sets match.

The build publishes every set's location, licence, `link` if it has one, and regions with their anchors,
without the names, in `symbols/index.json`. The debugger fetches it once, the first time it wants names,
and HTTP caching takes care of it after that; if the index or a set can't be fetched, it shows plain
addresses and tries again later, waiting longer after each failure, up to a limit, rather than retrying
at every stop, and for a linked file on someone else's site, at most once a session. Memory doesn't
change while the machine is stopped, so each time it stops the debugger checks every indexed region once
and keeps the answers until memory can change: the machine runs, or the user edits memory, restores a
snapshot or resets. Most regions fail on the first byte of their first anchor, so a few thousand regions
cost little next to drawing the view. Only a set that matches has its names fetched, and linked names
only once the user has agreed. Repton 2's set from the findings, 11 anchors in three regions, takes under
1 KB of the index, so hundreds of sets come to a few hundred KB. If the registry grows past a couple of
thousand sets, the index can be split into one static file per 256-byte page, listing the regions over
that page. Names need more than the pages on screen, though (the pages operands point into, the MOS's for
system globals, and every set that might name a global shown on its own), so that's for when one file
gets too big, not before.

A set that matches is shown, not offered (its linked names once the user has agreed to fetch them).
Matching anchors only show that the anchored bytes are the same, but in the corpus a region that matches
another title is that title's copy of the same code or data, nearly always with 90% or more of the file
identical ([below](#code-that-turns-up-elsewhere)), so its names fit. Where two versions differ between
the anchors, some names can be off, and the debugger says which set the names come from so that someone
who sees names that don't fit can drop it. Each set carries its own licence and provenance, so one found
this way needs nothing from a record.

### Code that turns up elsewhere

Anchors identify code, not discs. [The findings](media-registry-findings.md#anchors-across-titles) placed
every file on the Stairway To Hell discs at its load address and looked for anchor-sized runs of bytes at
the same address in other titles. Where they turn up, it's the same code or data, nearly always with 90%
or more of the file identical: the game in a compilation, on a cheat disc or in a re-release; an engine
that games share, such as the Scott Adams, Level 9, GAC and Epic adventure interpreters; or a loader a
publisher used again, such as Superior's at `&1900` in Baron, Barbarian II and 3D Dotty. Names made for
that code fit it wherever it turns up, as far as the code is the same.

The risk is a set that names game-specific things (its data, its globals) in a region anchored only on
shared code. A Level 9 game's set that took in the interpreter would label every Level 9 game's data with
that one game's names. So the chooser checks candidate anchors against the corpus, with files placed at
their load addresses, and flags any region that matches another title, for a person to judge; the report
goes in the pull request that adds the set. A match in a title the records already join to it (an alias,
a version, `contains`) isn't shared code, but it's reported all the same, since the two sets have to be
told apart or made one. The same game elsewhere is fine. Programs that differ only where they can't both
carry an anchor (in variables, a table of high scores, a run of `NOP`s a cheat poked) are the same code
too. Shared code becomes a set of its own, such as one Level 9 interpreter set for every Level 9 game,
and each game's set keeps to what's its own: for an adventure, its database, in a region anchored on data
the interpreter never writes (its text, vocabulary and action tables, not where the objects are). The
interpreter's stores go through pointers, so no store rule finds those parts; a person, or a reader for
the game's format, picks them. The interpreter's code then takes the database's names from another set's
matching region. A shared set has one licence, so a second contributor's names join it only under a
licence that combines with the first's; otherwise they can be its `link`, or a plain link once it has
one.

### ROMs

ROMs are the easy case. Nothing writes to them, so the store rule and the cuts at copies don't apply, and
anchors can sit anywhere but `&FC00-&FEFF` (below). Each ROM version gets a set: OS 1.20, the B+'s 2.00,
the Master's 3.20 and 3.50, the Compact's 5.10, the Electron's MOS, the US MOS and the Atom's; BASIC 2
and 4; each DFS and ADFS. The chooser tells the versions apart by checking each one's anchors against the
other versions' images, and in a ROM any byte where two versions differ can be an anchor. Sets for
different parts of memory match at once without any conflict: the MOS, whichever sideways ROM is paged
in, and the game in RAM. A language's set matches whenever it's paged in, which on a B is BASIC through
most games, so if it names its workspace as globals, a game's own names for those addresses are left bare
in the memory view; instructions aren't affected, since BASIC's globals name only BASIC's operands.

Anchors are read from the memory being looked at, so a sideways ROM's set matches in whatever slot the
ROM is in, with no field saying which, and shadow RAM works the same way. jsbeeb's debugger reads memory
as the CPU sees it, so stopped inside DFS code, DFS is what's paged in and its names show. Showing a bank
that isn't paged in would need jsbeeb's disassembly view to read a chosen bank, which is a change to
jsbeeb, not to the format.

A ROM address isn't always ROM, so a ROM's regions are cut at the bounds of what the hardware can put
over it. `&FC00-&FEFF` is I/O on the BBC Micro, the Master, the Compact and the Electron, so no region of
their ROMs covers it, and no anchor sits there even in a ROM image that has bytes for it: dumps of the
same ROM differ there (jsbeeb's Master MOS 3.20 and beebjit's differ in that range and nowhere else). The
Atom's I/O is at `&B000-&BFFF`, where it has no ROM, so its kernel's regions run to `&FFFF`, though its
anchors stay out of `&FC00-&FEFF` like every other set's, which keeps the build's check the same for all.
The Master can page HAZEL, its 8K of filing system RAM, over the MOS at `&C000-&DFFF` (bit Y of ACCCON),
and ANDY, 4K of RAM, over `&8000-&8FFF` of the sideways ROMs (bit 7 of ROMSEL); those are the bounds
jsbeeb's Master memory map uses. The B+ pages 12K of RAM over `&8000-&AFFF` by bit 7 of ROMSEL too,
though jsbeeb doesn't emulate the B+. The Compact pages its memory the same way as the Master. So the
Master's and the Compact's MOS are cut into `&C000-&DFFF`, `&E000-&FBFF` and `&FF00-&FFFF`, and while
HAZEL is in, the first region just doesn't match; and a sideways ROM's set is cut at `&9000` and `&B000`,
so the rest of it keeps its names while that RAM is in.

### Linked sets

Most disassemblies state no licence, so a set can't store their names, but it can point at them. A set
with only a link keeps just what's ours, its regions and anchors, which come from the code's own bytes,
and where the names live. A set can also store some names and link others: our MOS sets store the
documented interface and the system globals, and can link a fuller disassembly of the same ROM, whose
names show once the user agrees. System globals are stored, so they need no prompt, and stored names win
where the two disagree: a linked name for an address the set already names, or that the set already gives
to another address, is dropped. A set has one link, so any further disassembly of the same code is a
plain link, in the set's `links` or a record's. jsbeeb fetches linked names from the author's site when
someone wants them, and the registry never stores or republishes them. The debugger asks before fetching,
because it's someone else's work from someone else's site: it shows the author's `home` and the site the
file comes from, and remembers the answer for that `home` and that site together, so agreeing once never
sends a request to a site the user wasn't shown.

The link is pinned to an exact version (`raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>`, never
a branch), so the names and the anchors stay in step, and the set records the file's `sha256`, since a
URL alone can't prove the file won't change. The build fetches each pinned file once to check its digest,
that it parses and that labels land in each of the set's regions, and stores nothing; the client checks
the digest and the names the same way when it fetches them, and drops a file that doesn't match, and the
`url` and `home` are https. There are limits. The author's host has to allow fetches from another site
and serve a file pinned to a version: GitHub's raw files at a commit do, a page that changes (GitHub
Pages, most personal sites) doesn't, and those stay a plain link. The file has to carry addresses (a
listing, a symbol or label file, an assembler's report), since jsbeeb won't assemble anything, and its
format has to say which names are addresses, since constants stay out. The client gives a region the
names in its range and makes the rest globals, so the file has to hold only the set's program, and a name
the program uses as a global but that lies in a region's range, such as a table over run-once code,
becomes that region's and goes when it does. And each format needs a small converter in jsbeeb, so only a
few common ones are accepted. Where an author has said no reuse, their work is a plain link at most and
is never fetched. Asking authors for a licence still helps: a stored set needs no converter, and survives
the source moving or vanishing.

## Licensing

CC0 for our own data lets every emulator take it, as MAME does with its software lists.

Disassemblies need particular care. Several published BBC disassemblies have no licence at all, and some
say outright that no reuse is permitted. Without a licence, a set can only link their names ([linked
sets](#linked-sets)); where reuse is refused, they're a plain link at most, from a record or a set,
unless and until their authors tell us otherwise. Sources under the GPL aren't used for sets, stored or
linked, though a record or a set can link to them: the GPL's terms on what's made from a source are more
trouble than a registry of data other emulators take should carry. A permission such as the Atom sources'
travels with its set in the set's `licence`.

Acorn's documented interface is different. The MOS's entry points, vectors and workspace, as Acorn
documented them for programmers, are a published interface rather than anyone's disassembly, so sets of
them for each MOS version can be ours from the start, and with them the system globals.

The ROMs are well covered. Annotated disassemblies or reconstructed sources, most of them rebuilding byte
for byte, cover every BBC MOS from 0.10 to 2.00, the Master's 3.20 and 3.50, the Compact's 5.10, the
Electron's 1.00, BASIC I to 4r32 and HiBASIC, the DFSes and ADFS, and the Atom's ROMs. We treat Acorn's
ROMs and the sources Acorn has published (OS 1.20, BASIC 4 and DNFS 3.00) as effectively in the public
domain, so those sources can be where a stored set's names come from. So can the complete [Atom kernel
and BASIC sources](https://theoddys.com/acorn/acorn_system_computers/atom/atom.html): their site
[allows](https://theoddys.com/acorn/index.html) any use that isn't for commercial gain, which the
registry's isn't, and that permission is recorded as their licence. The other disassemblies almost all
state no licence; their authors are being asked for one, and until they give it, sets can only link
their names. py8dis's [`acorn.py`](https://github.com/ZornsLemma/py8dis/blob/master/py8dis/acorn.py),
under the MIT licence, names the OS vectors at `&0200-&0235`, the entry points at `&FFB9-&FFF7`, some of
zero page, and the FRED, JIM and SHEILA registers of the B, the Electron and the Master. With Acorn's
documented interface, that's where our own MOS sets start: CC0 where they come from Acorn's
documentation alone, MIT where they take from `acorn.py`, with its notice in the set's `notice`, since
MIT asks for it in every copy and sets are fetched one at a time.

Anchors are a few bytes of the program itself. They identify it rather than reproduce it, so we treat
them as facts about it, like a hash, and they're CC0 with the rest of our own data, whatever a set's
`licence` says about its names.

Instructions and screenshots have a copyright of their own. Which keys a game uses is a fact, so
`controls` records it along with where it came from, but the text of the instructions is content.

The detail behind the proposal's rules: permission to inline is recorded in the entry (a link to where it
was given, or when); disassemblies without a permissive licence or recorded permission are never stored
sets, only linked ones, or a plain link where their authors refuse reuse; MAME's software lists are CC0
and can be used directly; TOSEC's names and hashes are factual data, used with credit; and any database
without a stated licence is asked first and linked to meanwhile. Whether we mirror a disc image is a
separate decision about that image.

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

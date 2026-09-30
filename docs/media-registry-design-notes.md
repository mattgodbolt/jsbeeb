# Media registry: design notes

The reasons behind the choices in the [media registry proposal](media-registry-proposal.md), and the other
projects it borrows from. The numbers behind them are in [the findings](media-registry-findings.md).

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
  symbol to a JSON file with `--symbols`, which is pretty much a ready-made symbol format for the
  debugger. Rich was in the original #107 discussion too, and we've been talking with him about source
  formats since.
- [bbcmicro.co.uk](https://bbcmicro.co.uk) already launches jsbeeb from its game pages, passing a model
  and `KEY.` remaps in the URL, and its database has per-game keys and a platform. See
  [licensing](#licensing) before reaching for any of it.

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

On DFS discs, `&E5` (what a format leaves behind) and `&00` (padding) are the only trailing bytes the
corpus shows; any other repeated byte could just as easily be the end of a file. ADFS formatters and
duplicators left `&5A`, `&47`, `&F6` and others behind, and a blank second side of one of those would
otherwise stop a capture ever matching an image of its first side, so on ADFS any repeated byte counts.
Looking for the root directory's "Hugo" or "Nick" is the one bit of filesystem knowledge the fingerprint
needs. The [findings](media-registry-findings.md#trailing-fill) have the counts, including scarybeasts'
Master Compact captures.

## Reading flux captures

**Pitch.** A 40-track disc read in an 80-track drive has its data on the even tracks, and the odd tracks
are either empty or ghosts of their neighbours. Neither of the two signs is enough alone: protected discs
renumber their tracks, so the headers don't always give half the physical track, and some discs
legitimately repeat a track, so an odd track holding a copy isn't proof either. Captures whose data stops
before track 50 are taken as they are, which covers 40-track drives and discs whose data stops early.
jsbeeb's `sniffSurfaceLayout` does something like the header test, but once per disc, and a flippy disc
can have a different pitch on each side. The findings list the captures each part of the rule changes.

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

**Repeated sector IDs.** Keeping the first copy read made the key depend on where reading started, which
is how one pair of Empire Strikes Back images got different keys. On some protected discs the copies are
the protection, so keeping one, or none, would let discs that differ only there share a key. Keeping every
different copy in byte order costs at worst an alias when two captures read different copies, and a
wrong match is worse than a missed one. Counting copies wouldn't work, because two captures of the same
disc can read them different numbers of times.

**Incomplete sides.** The data is concatenated without positions, so if a sector is missing or unreadable
part way through (a damaged track, say), everything after it shifts, and the capture gets a key of its
own. That's a bad dump, which the registry handles as an alias like any other variant.

**Naming mirrors.** The HFE mirror doesn't use fingerprints to name its reconstructed captures, because it
needs one name per file, which is the file hash's job. A mirror names files, and the registry recognises
discs.

## FSD dumps

An FSD records each sector's header, data and read status, so it can be fingerprinted without rebuilding a
flux image first. A dump that marks a sector as a CRC error often overran it, and a good CRC after a
shorter length says the shorter read was right. A track the dump could only read headers from is the weak
spot: some captures hold `&E5` there, but nothing in the dump says so, which is why those keys are
provisional.

## Side keys

Some side digests are shared by lots of unrelated discs (every blank formatted side looks the same), so a
side key can't be trusted just because it matches. Publishing it only when it's unambiguous, and turning
it into an `ambiguous` record when that changes, means a published key always resolves to something
honest. A formatted but empty second side still has a catalogue on it, so a DSD with one gets a disc key
of its own, and finds the SSD's record through the side key.

## Tapes

Carrier, gaps, baud rate and how a container chunks things vary between captures of the same tape, so the
key is over the blocks the MOS would read. Protected tapes number their blocks in ways the MOS wouldn't
accept, and the loose-block records are how their content still gets into the key.

## Record chains

Instructions and keys belong to a title, symbols to a version, and a crack that moves code around needs to
override just the symbols. A chain merged with JSON Merge Patch does that with no special cases, and there
are libraries for it in pretty much every language. Merge Patch replaces arrays wholesale, which is why
collections are objects keyed by a stable name: a version can change one action, or add one link, without
repeating everything else.

Redirects are only for slugs, because a hash key is already an alias with a parent; if two title slugs are
merged, the losing one becomes a redirect.

## Symbols

BBC games rewrite their own memory all the time. Code is decrypted and relocated as it loads, variables
sit in amongst the code, self-modifying code is everywhere, and the emulator has no idea when loading has
finished. So a symbol set can't just be pinned to a disc and shown, and it can't be checked by hashing big
ranges of memory either. Anchors are cheap to check (a handful of bytes each time the debugger shows a
region), and before the code has arrived they simply don't match, so we never need to know when loading
is done.

The anchor rules come from trying it on Repton 2 (the findings have the details). Stores that can reach an
anchor would make it fail while the game runs; runs of `NOP`s are where cheats poke. Choosing anchors
turned out to be mostly automatic: given a disassembly listing, a tool can work out every address a store
can reach, list the candidate runs and pick about one per 2K of code. What stayed manual was naming the
regions and noticing which parts of the listing weren't the game (a disassembler's own loader, say). A big
file makes a poor single region, since one build difference is only caught if an anchor happens to sit on
it, hence smaller regions with `minAnchors`.

## Licensing

CC0 for our own data lets every emulator take it, as MAME does with its software lists.

Disassemblies need particular care. Several published BBC disassemblies have no licence at all, and some
say outright that no reuse is permitted. Those are links only, unless and until their authors tell us
otherwise.

Instructions and screenshots have a copyright of their own. Which keys a game uses is a fact, so
`controls` records it along with where it came from, but the text of the instructions is content.

## Finding aliases

Most of the work of filling the registry is mechanical, with an LLM helping on the calls that need
judgement, and nothing gets published until a person has looked at it.

Clustering by shared files is what links archives, since the keys mostly don't. Small files and files of
one repeated byte are shared by unrelated discs, and many protected discs catalogue only a loader, which
is why those are left out. Files are read the way the filesystem addresses them, not from the
fingerprint's byte stream, which on a protected disc holds extra sectors. A crack differs by a few bytes
in a loader; a menu disc is the game's files plus some extras; 40- and 80-track copies share every file;
a tape and a disc of the same game share the main code.

A judge's claims have to be checkable by a tool ("differs only in `$.LOADER`, at these bytes") so the
pipeline can check them again. The findings include a pilot: clustering over the whole corpus, and two
independent LLM judges on a sample of pairs.

The same pass can read keys off instruction screens, work out which machines each variant gets to a title
screen on, and list the images that don't work in jsbeeb at all. The findings' boot survey does the last
two for the whole corpus. What it gives for `requires` are candidates for a person to confirm, not
answers, because an Electron release or a gap in jsbeeb looks just like a machine requirement.

---

These notes were drafted by Claude (an LLM) with Matt, from a conversation about what's out there and what
jsbeeb needs. The survey of other projects was done by reading their code and documentation.

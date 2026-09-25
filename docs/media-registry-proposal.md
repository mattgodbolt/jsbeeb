# A media registry for BBC Micro software

jsbeeb can load a disc from pretty much anywhere, but once it's loaded we know very little about it. Some
sources tell us a title and a publisher; the Bitshifters manifest also tells us which machine a demo
needs. For everything else we have a pile of bytes. Issue
[#107](https://github.com/mattgodbolt/jsbeeb/issues/107) has been open since 2016 asking to show
annotated source in the debugger, [#748](https://github.com/mattgodbolt/jsbeeb/issues/748) asks for key
remapping inside the emulator (ideally remembered per disc), and mobile support needs to know which keys
a game actually uses before it can put a joystick on the screen. All of those need the same first step:
working out what software we've just loaded, and finding out things about it.

So the idea is a registry: compute an ID from any disc or tape image, fetch a JSON record keyed by that
ID, and use whatever's in it. The records are static files, so hosting is a directory on S3 and nothing
more, and the whole thing should be easy for other emulators to use too. Nothing here is implemented yet:
this is a proposal to pick holes in.

## What we want from it

The same disc should find the same record whatever format it arrives in: an SSD, a DSD, an ADFS image, a
flux capture in HFE, or any of those in a zip. That has to work without a special case per filesystem, as
ADFS discs matter as much as DFS ones.

Records should be static JSON, easy to mirror and archive, and they should be able to grow. We'll find
licences, links and control mappings long after a record is first written, and adding them shouldn't mean
bumping a format version.

Games come in versions, cracks, fixes and repackagings. The instructions and keys are usually the same
across all of them, but something like the addresses in the running code can change with even a minor
patch, so a version needs to be able to override bits of what it inherits.

Licensing has to be explicit. Every bit of third-party content says where it came from and under what
terms, and the registry never includes something it has no right to.

The records don't hold disc images, and the registry isn't trying to replace the archives that already
catalogue the software. A record links to wherever an image lives, which can be one of the archives or
one of our own mirrors on bbc.xania.org.

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
  catalogue by these per-side CRCs. The fingerprint below is the same idea with a longer hash, and a
  sector order that doesn't depend on how the disc was formatted.
- Clock Signal's Acorn analyser (Thomas Harte) guesses the machine and how to boot from the content
  alone: the catalogue's boot option, load addresses that need a second processor, which I/O addresses
  the code pokes. That's a good fallback when there's no record at all.
- Robert Smallshire's [Beebium](https://github.com/rob-smallshire/beebium) has per-game key mapping files
  that name the action each BBC key performs (`"keyName": "Caps Lock", "action": "Rotate Left"`), and
  Robert has said he's keen on an emulator-agnostic way of describing game actions. The controls part of
  this should be worked out with him rather than separately.
- Rich Talbot-Watkins' [Baron](https://github.com/waitingforvsync/baron) assembler writes every resolved
  symbol to a JSON file with `--symbols`, which is pretty much a ready-made symbol format for the
  debugger. Rich was in the original #107 discussion too, and we've been talking with him about source
  formats since.
- [bbcmicro.co.uk](https://bbcmicro.co.uk) already launches jsbeeb from its game pages, passing a model
  and `KEY.` remaps in the URL, and its database has per-game keys and a platform. See the licensing
  section before reaching for any of it.

## Identity

### Keys

A key is 32 lowercase hex characters, the first 128 bits of a SHA-256. All keys live in one namespace,
whatever they were computed from. I don't see why each kind of hash would need its own directory: if two
kinds of key could collide, the hash is a bad hash. If we ever change how a key is computed, the new keys
just become more aliases and the old ones keep working.

There are two ways to get a key from an image. The fingerprint is computed from the disc's sectors
(below), and it's the one that finds the same disc across formats. The file hash is the SHA-256 of the
file as downloaded, which any tool can compute without decoding a disc, and which lines up with the hash
lists other projects publish. A client works out whichever keys it can and tries them in the order given
below.

beebjit's CRC is only 32 bits a side, which is a bit short to share a namespace with thousands of other
keys, so it's recorded as a plain field where we have it. Our HFE mirror's manifest already maps those
CRCs to discs, so anything keyed on them can be translated in bulk.

### The disc fingerprint

The fingerprint's job is quite narrow: to recognise the same dump of a disc whatever container it's in.
Recognising two discs that are functionally the same but laid out differently (one of them `*COMPACT`ed,
say) is a job for the file-level matching described later, not for the key.

It's computed from the disc as it was loaded, before any writes, and it knows nothing about DFS, ADFS or
any other filesystem. Each physical side gets a digest of its own.

For sector images (SSD, DSD, and the 8-bit ADFS S, M and L formats) the side digest is simply the SHA-256
of that side's bytes, in the order the image stores them, with two tweaks. The sides are separated
according to the format's interleave (an `.adf` file bigger than an ADFS M disc is an L disc, whose sides
alternate track by track, whatever its name says), and trailing fill is trimmed: whole 256-byte sectors
at the end of the side that are all `&00` (padding) or all `&E5` (what a format leaves behind) are
dropped, and a short last sector is padded with zeros first. Baron, for one, truncates its SSDs after the
last used sector, and plenty of tools pad them to 200K, so the trimming is what lets those agree. Only
fill is dropped, so a reused disc with old data past its last file keeps it. No disc model is needed at
all, which should make this pretty easy for any emulator to implement.

For flux images, the job is to turn the capture back into those same bytes:

1. Decide whether the side is a 40-track disc read in an 80-track drive. If nothing past physical track
   50 holds data, every track that does is taken as real: either the capture came from a 40-track drive,
   or the disc's data stops early, and then an odd track holding data holds its own. Otherwise, counting
   only sectors with good header and data CRCs, it's 40-track if at least four even tracks, not counting
   track 0, have a sector whose header gives half their physical track number, and more even tracks do
   that than give their own number. Failing that, it's 40-track if at least four even tracks hold data
   and the odd tracks holding any sector that isn't a copy of an even neighbour's number fewer than a
   tenth of those even tracks. Odd tracks that read nothing at all count as copies, so an 80-track
   capture whose odd tracks all failed to read would be taken as 40-track; that's a bad dump anyway.
   Neither test is enough alone: protected discs renumber their tracks, and some discs legitimately
   repeat one ([the findings](media-registry-findings.md) have the details). jsbeeb's
   `sniffSurfaceLayout` does something like the first, but once per disc, and a flippy disc can have a
   different pitch on each side.
2. Decode the side's tracks into sectors, reading physical tracks in ascending order (only the even ones
   on a 40-track side) and each track from the index.
3. Keep the sectors with good header and data CRCs, whatever track their headers claim.
4. Sort them by the track they were read from, then header track, then header sector ID, keeping the
   first one read if all three turn up twice, so sector skew doesn't matter.
5. Concatenate their data, then trim and hash it exactly as for a sector image, treating the
   concatenation as 256-byte blocks whatever sizes the sectors were.

Step 3 drops bad-CRC sectors because weak sectors read differently on every capture, and two captures of
the same original need to agree. It keeps sectors whose headers claim some other track, and an earlier
draft that dropped them got this badly wrong: Superior's protection renumbers every track after track 0
(physical track 4 says it's track 200, and so on down), so the rule threw away the whole game and kept
only the boot track. Exile and Repton Infinity share that boot track byte for byte, and ended up with the
same key. The numbers are in [the findings](media-registry-findings.md). For an unprotected disc the
headers match anyway, so the order is the same as an SSD's and so are the bytes. The price is that a
capture of a protected disc no longer matches an SSD made from it, because the SSD can't hold the
renumbered sectors. The findings suggest that hardly ever happened anyway: of the captures that share
most of their files with a Stairway To Hell SSD, nearly nine in ten have those files at different
sectors, so the SSDs are mostly re-mastered, not dumped.

This only works for a complete side. The data is concatenated without positions, so if a sector is
missing or unreadable part way through (a damaged track, say), everything after it shifts, and the
capture gets a key of its own. That's a bad dump, which the registry handles as an alias like any other
variant.

FSD sector dumps can be fingerprinted directly too, since they record each sector's header, data and read
status. A sector counts when the dump read it cleanly, or when its data had a CRC error but the bytes it
overran hold a good CRC after a shorter power-of-two length (and then only that length counts). The order
is the same as for flux images. A track the dump could only read headers from has no data to hash, so a
dump with such tracks gives a provisional key, recorded as such and never used to merge it with other
images.

The disc key is the SHA-256 of the full 32-byte side digests in physical order, leaving out trailing
sides with nothing left in them, cut to 128 bits. Each side digest, cut the same way, is a side key. So
an SSD, an HFE and a zip of the same single-sided disc share a key, and so do a DSD and an HFE of the
same double-sided one. A DSD whose second side is unformatted or all fill has the same disc key as an SSD
of its first side. A formatted but empty second side still has a catalogue on it, so that DSD gets a disc
key of its own, and finds the SSD's record through the side key.

The HFE mirror doesn't use fingerprints to name its reconstructed captures, because it needs one name per
file, which is the file hash's job. That's fine: a mirror names files, and the registry recognises discs.

A client tries the file hash first, then the disc key, then the side keys in side order, and uses the
first record it finds. Some side digests are shared by lots of unrelated discs (every blank formatted
side looks the same), so a side key is only published when every image known to have that side belongs to
one title. If a later image shows a published side key is shared after all, its record becomes an
`ambiguous` one listing the candidate titles, and a client treats that as no match (or offers the
choice). That way the key still resolves.

The spec should come with a reference implementation in JavaScript and C, plus test vectors: the same
single-sided disc as a trimmed SSD, a padded SSD and an HFE, a double-sided DFS disc as a DSD and an HFE,
and an ADFS L disc as an interleaved image and an HFE. A protected original captured twice should give
the same key both times.

### The tape fingerprint

A tape is decoded to the bytes it carries, whatever the container: UEF data chunks (&0100 and &0104), or
CSW pulses at 1200 baud. That stream is searched for the blocks the MOS writes: &2A, a name of up to ten
characters and a zero, load and execution addresses, block number, length, flags and four spare bytes, a
CRC-16 of those, then the data and its CRC. Blocks with a bad CRC are dropped. Consecutive blocks with
the same name, numbered up from 0 to one with bit 7 of its flags set, make a complete file, and a block
that repeats the one before it is skipped.

The tape key is the SHA-256, cut to 128 bits, of a sequence of records in tape order. Each complete file
gives `&46`, its name and a zero, its load, execution address and length (32-bit little-endian), then its
data. Each good block that isn't part of a complete file gives `&42`, its name and a zero, its load and
execution addresses, its block number (16-bit) and flags, its length (32-bit), then its data; that's how
protected tapes whose loaders number blocks the MOS wouldn't accept still get their whole content into
the key. A record identical to the one before it is left out. Carrier, gaps, baud rate, how the container
chunks things, and bytes outside MOS blocks don't count.

ROMs can just use the file hash.

## Records

Every record is a JSON file named `<key>.json`, where the key is either a hash or a title slug. Slugs are
short, lowercase and hyphenated (`exile`, `exile-v1-1`) and never 32 hex characters, so the two can't
clash. Every record has a `kind`.

### Chains of records

Records form a chain: an alias points at a version, and a version points at a title. Any record can set
any field, and the metadata for a particular image is the chain merged from the title down, using [JSON
Merge Patch (RFC 7396)](https://www.rfc-editor.org/rfc/rfc7396), where objects merge, anything else
replaces, and `null` removes. There are libraries for it in pretty much every language.

```
exile                    title: instructions, controls, links
+-- exile-v1-1           version: its symbols (and nothing else)
    +-- <fingerprint A>  alias: "original, protected"
    +-- <fingerprint B>  alias: "protection removed"
    +-- <file hash C>    alias: "the archive's zip of B"
```

Instructions and keys live once, on the title. Every copy of version 1.1 gets the 1.1 symbols. If one
particular crack moves code around, that alias overrides `source` again and nothing else changes. The
chain can be as deep as it needs to be; title, version, alias is the convention.

Merge Patch replaces arrays wholesale, so collections are objects keyed by a stable name instead. That
way a version can change one action, or add one link, without repeating everything else.

### Some examples

A title:

```json
{
  "format": 1,
  "kind": "title",
  "title": "Exile",
  "publisher": "Superior Software",
  "year": 1988,
  "requires": { "machines": ["B", "Master"] },
  "controls": {
    "actions": {
      "left": { "keys": ["Q"], "role": "left" },
      "right": { "keys": ["W"], "role": "right" },
      "thrust-up": { "keys": ["P"], "role": "up" },
      "thrust-down": { "keys": ["L"], "role": "down" }
    }
  },
  "links": {
    "catalogue": { "url": "https://...", "rel": "catalogue" }
  },
  "provenance": {
    "controls": { "source": "...", "method": "read from the instructions screen" }
  }
}
```

(Exile has plenty more keys than that, of course.)

An alias:

```json
{
  "format": 1,
  "kind": "alias",
  "parent": "exile-v1-1",
  "note": "copy protection removed",
  "tags": ["cracked"],
  "seenIn": { "sth": "Superior/Exile.zip" }
}
```

Redirects are only ever for slugs. A hash key is already an alias with a parent, so it never needs one;
if two title slugs are merged (say we'd ended up with both `exile-bbc` and `exile`), the losing slug's
file becomes a redirect to the other, and a client fetching `exile-bbc.json` goes on to fetch
`exile.json`:

```json
{ "format": 1, "kind": "redirect", "to": "exile" }
```

And the record a side key becomes if it turns out to be shared:

```json
{ "format": 1, "kind": "ambiguous", "candidates": ["exile", "citadel"] }
```

### A first set of fields

The identity fields are the obvious ones (`title`, `publisher`, `year`, `authors`), plus `aliases` for
other names, `parent`, and relations such as `contains` for a compilation disc with several titles on it.

`requires` covers the machine, a second processor, ROMs, 40 or 80 tracks and any other hardware. `boot`
is optional and usually absent, meaning "do what the disc's boot option says"; it's only there for the
rare disc that needs `CHAIN""` or some text typed.

`controls` lists actions, each with the BBC keys that perform it, a label, and optionally a standard
`role` (`left`, `right`, `up`, `down`, `fire`, `fire2` and so on). A touch joystick or a gamepad mapping
can be built from the roles automatically, and anything without a role becomes a labelled button. Which
host keys, touch layout or gamepad buttons drive those actions is up to each front end, so none of that
goes in the record. This is the part to design with Robert.

`links` points at pages elsewhere (catalogue entries, disassemblies, inlay scans, homepages), each with a
`rel`. `content` is material shown inline (instructions, screenshots, symbol sets), each with a `url`, a
`source` and a `licence`. `provenance` says where a field's value came from and how.

### Symbols and source

This part has been tried on one game, Repton 2 (the findings have the details), but it's still the least
settled.

BBC games rewrite their own memory all the time. Code is decrypted and relocated as it loads, variables
sit in amongst the code, self-modifying code is everywhere, and the emulator has no idea when loading has
finished. So a symbol set can't just be pinned to a disc and shown, and it can't be checked by hashing
big ranges of memory either.

Instead a symbol set is split into regions, and each region carries a few anchors: short runs of bytes at
known addresses that should be there whenever that region's code is in memory. An anchor is a run of
whole instructions, four to eight bytes, starting at a routine's entry point; no store in the program may
be able to reach any of its bytes (counting the full reach of indexed stores); it mustn't be a run of
`NOP`s, which is exactly what cheats poke; and its bytes must appear only once in the region. Overlays
(code that swaps in and out at the same addresses) are just separate regions that happen to cover the
same addresses. Symbols that aren't in any region (zero page, OS entry points) go in a `globals` block,
shown whenever any region matches.

```json
{
  "source": {
    "exile-v1-1-labels": {
      "format": "baron-symbols",
      "url": "https://.../exile-v1-1.json",
      "globals": ["zp", "os"],
      "regions": {
        "main": {
          "start": "0x1100",
          "end": "0x5800",
          "minAnchors": 2,
          "anchors": [{ "at": "0x1a2c", "bytes": "a9008d..." }]
        }
      },
      "licence": "CC0-1.0"
    }
  }
}
```

The debugger checks a region's anchors whenever it's about to show that region (stopped at a breakpoint,
or scrolling the disassembly), which is only a handful of bytes each time. Labels appear for the regions
whose anchors match. Before the code has arrived, the anchors don't match and there are no labels, so we
never need to know when loading is done. If nothing matches, the debugger shows plain addresses as it
does today.

Choosing anchors turned out to be mostly automatic: given a disassembly listing, a tool can work out
every address a store can reach, list the candidate runs and pick about one per 2K of code. What stayed
manual was naming the regions and noticing which parts of the listing weren't the game (a disassembler's
own loader, say). Anchors are still optional: a symbol set without them isn't shown automatically, but
can be picked by hand in the debugger. A big file makes a poor single region, since one build difference
is only caught if an anchor happens to sit on it; smaller code regions, each with `minAnchors`, are
better.

## Keeping records stable

Records are sort of immutable. They can grow, but anything a client relies on stays put:

- `format` is 1, and only changes for something that would break a reader of format 1.
- Fields can be added to any record at any time, and clients ignore fields they don't know.
- A field never changes meaning; removing one is a format change.
- A published key always resolves. If two title slugs are merged, the old one becomes a `redirect`; a
  hash key just gets a new parent.
- Files are served with a short cache lifetime and ETags, not as immutable.

## Storage and serving

The registry is a git repository of JSON files, one per record, published as a static tree (S3, or
bbc.xania.org next to the existing mirrors) with CORS open. A build step checks every record against the
schema and the licensing rules, and also publishes the whole lot as one compressed newline-delimited JSON
file for anyone who wants everything, or an offline copy. Contributions are pull requests.

A lookup is `GET <root>/<key>.json`, then the same for each `parent`, following at most a handful of
redirects.

## Licensing

The build step enforces these rules.

The registry's own data is CC0: keys, hashes, computed facts (sector counts, file lists, load addresses),
structure and relations. Those are ours to publish, and CC0 lets every emulator take them, as MAME does
with its software lists.

Every field that came from somewhere else records its `source` and `licence`. A `content` or `source`
entry without a licence fails the build.

There are three levels of use:

- Linking is always fine, whatever the licence of the thing linked to. A link to a disassembly, a
  catalogue page or an inlay scan needs nobody's permission.
- Inlining, with attribution, needs a licence that allows redistribution, or the author's permission
  recorded in the entry (a link to where it was given, or when).
- Never: anything whose licence we don't know. Disc and tape images are never part of a record either; a
  record links to wherever an image lives, and whether we mirror one is a separate decision about that
  image.

Disassemblies need particular care. Several published BBC disassemblies have no licence at all, and some
say outright that no reuse is permitted. Those are links only, unless and until their authors tell us
otherwise. Only disassemblies under a permissive licence, or with recorded permission, get turned into
inline symbol sets.

For other databases: MAME's software lists are CC0 and can be used directly. TOSEC's names and hashes are
factual data, used with credit. Any database without a stated licence gets asked before we import
anything from it, and gets linked to in the meantime.

Instructions and screenshots have a copyright of their own. Which keys a game uses is a fact, so the
`controls` field records it along with where it came from, but the text of the instructions themselves is
content and follows the rules above. Whether we can host emulator screenshots of commercial games is an
open question.

## Filling it in

### Where the data comes from

We can start with our own mirror of the Stairway To Hell archive (which we can hash in full), MAME's
software lists, TOSEC's names and hashes, the Bitshifters manifest, and jsbeeb's HFE captures, which are
already named by beebjit's CRCs or by file hash. Other catalogues, and their key and platform data, come
after asking.

### Finding aliases automatically

Most of this is mechanical, with an LLM helping on the calls that need judgement. Nothing gets published
until a person has looked at it.

1. Collect. For each image, record where it came from, its file hash, disc key and side keys, and a
   decoded file list (DFS, ADFS or tape) with names, addresses, lengths and a hash per file.
2. Group exact matches. Equal fingerprints are aliases, no judgement required.
3. Find candidates. Images whose shared files (by content) make up at least half of each go into one
   family; when they make up half of only the smaller one, the bigger contains the smaller, which is how
   compilations and menu discs show up. Files are read the way the filesystem addresses them (by each
   sector's header), not from the fingerprint's byte stream, which on a protected disc holds extra
   sectors. A crack differs by a few bytes in a loader; a menu disc is the game's files plus some extras;
   40- and 80-track copies share every file; a tape and a disc of the same game share the main code.
4. Judge each cluster. An LLM works through tools (a byte diff, the disassembler, a BASIC detokeniser,
   and headless jsbeeb to boot the disc and read the title screen) and puts each difference into a fixed
   set of categories: same dump, bad dump, remastered (the same files written out again by a tool), disc
   written to (a later write, a changed cycle number, leftover data), protection removed, trainer or
   cheat, menu or extras added, compilation (with which one contains which), another disc of the same
   set, the same release packaged for 40 or 80 tracks, compatibility fix, publisher revision, port, or
   different software. Every claim has to be something a tool can check ("differs only in `$.LOADER`, at
   these bytes"), and the pipeline checks it again.
5. Review. Each cluster becomes a pull request of alias records with its evidence and a confidence level.
   A person approves it, and the records' provenance says they were proposed by automated analysis and
   then reviewed.

The same pass can read keys off instruction screens (noting where it found them), work out which machines
each variant gets to a title screen on, and list the images that don't work in jsbeeb at all. The
findings' boot survey does the last two for the whole corpus; what it gives for `requires` are candidates
for a person to confirm, not answers, because an Electron release or a gap in jsbeeb looks just like a
machine requirement.

The findings include a first pilot of steps 3 and 4: clustering over the whole corpus, and two
independent LLM judges on a sample of pairs.

## Uses in jsbeeb

The media window would show a title, instructions, screenshots and links for anything loaded, through the
existing `MediaLoader.addDescriber` hook. `requires` would feed the machine switch that already acts on
the Bitshifters `machine` field. The `controls` roles would give phones and tablets a joystick and
buttons, and gamepads some sensible defaults. The debugger would label addresses from symbol sets whose
anchors match, which is #107. Snapshots could record the fingerprint next to the raw file CRC32 they use
today, so a snapshot can say what software it needs and help find a copy, though restoring one mid-load
still wants the exact image. And with no record at all, content heuristics like Clock Signal's could
still guess the machine and how to boot.

## Open questions

- Title slugs: our own, with MAME's short names and other catalogues' IDs as cross-references, or just
  MAME's names.
- Whether 128 bits is the right key length. The HFE mirror's file-hash names use 64, which may be a bit
  short for a registry other emulators share.
- Whether custom-format tape data (bytes outside MOS blocks, which the tape key ignores) can be decoded
  consistently enough to include.
- What to keep when a track repeats a sector ID with different contents. "The first one read" depends on
  where reading starts, which is how one pair of Empire Strikes Back images got different keys; keeping
  each distinct content once, in byte order, wouldn't. Only three tracks in 427 FSD dumps do this, but it
  should be settled before the spec is.
- Whether a few bytes of duplicator leftovers on a protected track (Philosophers Quest, and perhaps
  Hopper) should split two copies. The key says they're different copies, which is true, so it may be
  fine as long as an alias joins them.
- Where the repository lives and what it's called, so other emulators feel it's theirs as well.
- The `controls` schema, with Robert and Beebium.
- Whether, and how, we can host screenshots.

Do let me know what you think, preferably as comments on the PR.

---

This proposal was drafted by Claude (an LLM) with Matt, from a conversation about what's out there and
what jsbeeb needs. The survey of other projects was done by reading their code and documentation.

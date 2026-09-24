# A media registry for BBC Micro software

jsbeeb can load a disc from pretty much anywhere, but once it's loaded we know very little about it. Some
sources tell us a title and a publisher; the Bitshifters manifest also tells us which machine a demo
needs. For everything else we have a pile of bytes. Issue
[#107](https://github.com/mattgodbolt/jsbeeb/issues/107) has been open since 2016 asking to show
annotated source in the debugger, [#748](https://github.com/mattgodbolt/jsbeeb/issues/748) asks for key
remapping inside the emulator (ideally remembered per disc), and mobile support needs to know which keys
a game actually uses before it can put a joystick on the screen. All of those need the same first step:
working out what software we've just loaded, and finding out things about it.

So the idea is a registry. Compute an ID from any disc or tape image, fetch a JSON record keyed by that
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

What we don't want is to host disc images, or to replace the archives that already catalogue the
software. The registry links to them.

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

There are two ways to get a key from an image. The fingerprint is computed from the decoded sectors
(below), and it's the one that finds the same disc across formats. The file hash is the SHA-256 of the
file as downloaded, which any tool can compute without decoding a disc, and which lines up with the hash
lists other projects publish. A client works out whichever keys it can and tries them in the order given
below.

beebjit's CRC is only 32 bits, which is a bit short to share a namespace with thousands of other keys, so
it's recorded as a plain field where we have it.

### The disc fingerprint

This is computed from the disc as it was loaded, before any writes, and it knows nothing about DFS, ADFS
or any other filesystem. Each physical side is fingerprinted on its own:

1. Decide the side's track pitch first, from its sector headers: if the headers on the even physical
   tracks give half their physical track number, it's a 40-track side read in an 80-track drive. jsbeeb's
   `sniffSurfaceLayout` does something similar, but once per disc and only for flux images, and a flippy
   disc can have a different pitch on each side.
2. Decode the side's tracks into sectors, as the disc controller would see them, reading physical tracks
   in ascending order and each track from the index.
3. Keep the sectors with good header and data CRCs whose header track number matches the track they were
   read from (the physical track, or half of it for a 40-track side). The rest are protection or damage.
   beebjit's track check is looser: it drops only sectors whose header says track `&FF`, or track 0 on
   some other track.
4. Sort what's left by header track, then header sector ID, keeping the first one read if a track and ID
   turn up twice. Going by header values means sector skew doesn't matter, and nor does which drive
   captured the disc.
5. Drop sectors from the end of the side while their data is one repeated byte (zero padding, or the
   `&E5` a format leaves behind). Baron, for one, truncates its SSDs after the last used sector, and
   plenty of tools pad them to 200K. Only fill is dropped, so a reused disc with old data past its last
   file keeps it, and a truncated copy of that disc won't match a full one.
6. The side digest is the SHA-256 of one record per remaining sector, in order: header track, sector ID
   and size code (a byte each), a byte that is 1 for a deleted data mark and 0 otherwise, the data length
   (16-bit little-endian), then the data.

Steps 1 and 2 are for flux images, which have real headers to read. Sector images (SSD, DSD and the ADFS
formats) don't have headers at all, so an implementation doesn't decode them or guess a pitch: each
256-byte block in the image becomes a sector whose header is the logical track and the sector's position
within that track (0 to 9 for DFS, 0 to 15 for ADFS), with size code 1 and a normal data mark, taking the
sides in the order the format interleaves them. That's exactly what jsbeeb's loaders synthesise, before
they place 40-track images on the even physical tracks, and it's what a flux capture of the same disc
reads back once step 3 has matched each header to its track.

The side number doesn't go into a digest, because jsbeeb and beebjit both write head 0 into every
synthesised sector header. The disc key is the SHA-256 of the full 32-byte side digests in physical
order, leaving out trailing sides with no sectors left, cut to 128 bits. Each side digest, cut the same
way, is a side key.

That gets us one key for an SSD, an HFE and a zip of the same single-sided disc, and for a DSD and an HFE
of the same double-sided one. A DSD whose second side is unformatted or all fill has the same disc key as
an SSD of its first side. A formatted but empty second side still has a catalogue on it, so that DSD gets
a disc key of its own, and finds the SSD's record through the side key.

A protected original and its flux capture share a key, and so do two copies whose only difference is
protection that step 3 drops (bad CRCs, sectors claiming the wrong track). That's what we want for
looking up metadata, and it's exactly why the HFE mirror doesn't use fingerprints to name its
reconstructed captures: it needs one name per file, which is the file hash's job. Protection made of
deleted data marks, odd sector IDs or sizes, or extra good sectors still changes the key. A cracked copy,
whose code has changed, gets a different key too, and reaches the same title through an alias of its own.

A client tries the file hash first, then the disc key, then the side keys in side order, and uses the
first record it finds. Some side digests are shared by lots of unrelated discs (every blank formatted
side looks the same), so a side key is only published when every image known to have that side belongs to
one title. If a later image shows a published side key is shared after all, its record becomes an
`ambiguous` one listing the candidate titles, and a client treats that as no match (or offers the
choice). That way the key still resolves.

The spec should come with a reference implementation in JavaScript and C, plus test vectors: the same
single-sided disc as a trimmed SSD, a padded SSD and an HFE, and the same double-sided disc as a DSD, an
interleaved ADFS image and an HFE.

Tapes need their own version, computed from the decoded blocks (file name, load and execution addresses,
data) rather than from the UEF or audio container. ROMs can just use the file hash.

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
  "boot": { "method": "shift-break" },
  "controls": {
    "actions": {
      "left": { "keys": ["Z"], "role": "left" },
      "right": { "keys": ["X"], "role": "right" },
      "fire": { "keys": ["Return"], "role": "fire" }
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

(The values are illustrative; nobody has checked Exile's keys for this.)

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

And the redirect left behind when two records are merged:

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
says how to start it: Shift+Break, `CHAIN`, `*RUN`, or some text to type.

`controls` lists actions, each with the BBC keys that perform it, a label, and optionally a standard
`role` (`left`, `right`, `up`, `down`, `fire`, `fire2` and so on). A touch joystick or a gamepad mapping
can be built from the roles automatically, and anything without a role becomes a labelled button. Which
host keys, touch layout or gamepad buttons drive those actions is up to each front end, so none of that
goes in the record. This is the part to design with Robert.

`links` points at pages elsewhere (catalogue entries, disassemblies, inlay scans, homepages), each with a
`rel`. `content` is material shown inline (instructions, screenshots, symbol sets), each with a `url`, a
`source` and a `licence`. `provenance` says where a field's value came from and how.

### Symbols and source

A symbol set says which memory ranges it describes and what the bytes there should hash to while the
software is running:

```json
{
  "source": {
    "exile-v1-1-labels": {
      "format": "baron-symbols",
      "url": "https://.../exile-v1-1.json",
      "verify": [{ "start": "0x1100", "end": "0x5800", "sha256": "..." }],
      "licence": "CC0-1.0"
    }
  }
}
```

The debugger checks live memory against `verify` before showing any labels. That catches the things disc
identity can't: code that's decrypted or relocated as it loads, a variant nobody has catalogued, a
machine that loads it somewhere else. It also means a record can offer a few candidate sets and the
emulator picks whichever one matches, and if none do, the debugger shows plain addresses as it does
today.

## Keeping records stable

Records are sort of immutable. They can grow, but anything a client relies on stays put:

- `format` is 1, and only changes for something that would break a reader of format 1.
- Fields can be added to any record at any time, and clients ignore fields they don't know.
- A field never changes meaning; removing one is a format change.
- A published key always resolves. If records are merged, the old one becomes a `redirect`.
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
- Never: the software itself (we don't host images), and anything whose licence we don't know.

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
3. Find candidates. Images that share files, or that are near-duplicates by a fuzzy hash (ssdeep or TLSH,
   over files and over the sector stream), go into clusters. A crack differs by a few bytes in a loader;
   a menu disc is the game's files plus some extras; 40- and 80-track copies share every file; a tape and
   a disc of the same game share the main code.
4. Judge each cluster. An LLM works through tools (a byte diff, the disassembler, a BASIC detokeniser,
   and headless jsbeeb to boot the disc and read the title screen) and puts each difference into a fixed
   set of categories: format conversion, bad dump, protection removed, trainer, menu or instructions
   added, compatibility fix, publisher revision, port, or different game. Every claim has to be something
   a tool can check ("differs only in `$.LOADER`, at these bytes"), and the pipeline checks it again.
5. Review. Each cluster becomes a pull request of alias records with its evidence and a confidence level.
   A person approves it, and the records' provenance says they were proposed by automated analysis and
   then reviewed.

The same pass can read keys off instruction screens (noting where it found them), work out which machines
each variant gets to a title screen on, and list the images that don't work in jsbeeb at all.

A sensible first step is a pilot: one game with lots of versions, done by hand across our own mirror and
TOSEC. That should show how much steps 2 and 3 sort out on their own, and whether the judgements in step
4 are any good.

## Uses in jsbeeb

The media window would show a title, instructions, screenshots and links for anything loaded, through the
existing `MediaLoader.addDescriber` hook. `requires` would feed the machine switch that already acts on
the Bitshifters `machine` field. The `controls` roles would give phones and tablets a joystick and
buttons, and gamepads some sensible defaults. The debugger would label addresses from verified symbol
sets, which is #107. Snapshots could record the fingerprint next to the raw file CRC32 they use today, so
a snapshot can say what software it needs and help find a copy, though restoring one mid-load still wants
the exact image. And with no record at all, content heuristics like Clock Signal's could still guess the
machine and how to boot.

## Open questions

- Title slugs: our own, with MAME's short names and other catalogues' IDs as cross-references, or just
  MAME's names.
- Whether 128 bits is the right key length. The HFE mirror's file-hash names use 64, which may be a bit
  short for a registry other emulators share.
- The tape fingerprint in detail, and whether a tape should also match a disc with the same files on.
- Whether trailing-fill trimming should allow any repeated byte, or only zero and `&E5`.
- Whether step 3 of the fingerprint should also drop the odd sizes and IDs that protection uses, so a
  protected original matches a plain SSD made from it.
- Where the repository lives and what it's called, so other emulators feel it's theirs as well.
- The `controls` schema, with Robert and Beebium.
- Whether, and how, we can host screenshots.

Do let me know what you think, preferably as comments on the PR.

---

This proposal was drafted by Claude (an LLM) with Matt, from a conversation about what's out there and
what jsbeeb needs. The survey of other projects was done by reading their code and documentation.

# A media registry for BBC Micro software

A registry lets an emulator work out what software it has just loaded and find out things about it: a
title, instructions, which keys it uses, which machine it needs, symbols for the debugger
([#107](https://github.com/mattgodbolt/jsbeeb/issues/107)). A client computes a key from any disc or tape
image, fetches a static JSON record for it, and uses whatever's in it. Nothing here is implemented yet;
this is a proposal to pick holes in.

This document says what to build. Why it's built that way, and the projects it borrows from, are in [the
design notes](media-registry-design-notes.md); the evidence is in [the
findings](media-registry-findings.md), from prototype tools in `tools/registry/`.

## Keys

A key is 32 lowercase hex characters: the first 128 bits of a SHA-256. All keys share one namespace
([why](media-registry-design-notes.md#one-key-namespace)). An image can have:

- a **file key**: the SHA-256 of the file as downloaded;
- a **disc key** and one **side key** per side, from the [disc fingerprint](#disc-fingerprint);
- a **tape key**, from the [tape fingerprint](#tape-fingerprint).

ROMs use the file key. A client tries the file key, then the disc or tape key, then the side keys in side
order, and uses the first record it finds. beebjit's 32-bit per-side CRC is recorded as a field where we
have it, not as a key.

## Disc fingerprint

Computed from the disc as it was loaded, before any writes. Each physical side gives one side's bytes;
the bytes are trimmed and hashed the same way whatever the image was.

### Sides from a sector image

The side's bytes are the image's bytes in the order it stores them. SSD and ADFS S and M images are one
side. DSD (10 sectors of 256 bytes a track) and ADFS L (16 a track) images alternate the two sides track
by track; an `.adf` or `.adm` bigger than 80 × 16 × 256 bytes is an L disc whatever its name says.

### Sides from a flux image

1. **Pitch.** Count only sectors with good header and data CRCs. If nothing past physical track 50 holds
   data, read every track. Otherwise the side is 40-track (read only the even tracks) if either:
   - at least four even tracks other than track 0 have a sector whose header gives half their physical
     track number, and more even tracks do that than give their own number; or
   - at least four even tracks hold data, and the odd tracks holding any sector that isn't a copy of an
     even neighbour's number fewer than a tenth of them (an odd track that read nothing counts as a copy,
     so an 80-track capture whose odd tracks all failed to read is taken as 40-track; that's a bad dump
     anyway).
2. **Decode** the tracks into sectors, physical tracks in ascending order.
3. **Keep** sectors with good header and data CRCs, whatever track their headers claim.
4. **Order** them by the track they were read from, then header track, then header sector ID. When all
   three repeat, keep each different content once, in ascending byte order (a sector sorts before a
   longer one it is the start of), and identical copies once.
5. **Concatenate** their data; that's the side's bytes, whatever sizes the sectors were.

The reasons for each step are in [the design
notes](media-registry-design-notes.md#reading-flux-captures).

### Sides from an FSD dump

No pitch test: every track in the dump is read, and sectors are ordered as in step 4 above, with the
track each sector was dumped from in place of the track it was read from. A sector counts when the dump
read it cleanly, or when its data had a CRC error but the bytes it overran hold a good CRC after a
shorter power-of-two length, and then only that length counts. A track the dump could only read headers
from contributes nothing, and the key is recorded as provisional: never used to merge the dump with other
images ([why](media-registry-design-notes.md#fsd-dumps)).

### Trimming

Treat the side's bytes as 256-byte blocks, whatever sizes its sectors were: pad a short last block with
zeros, then drop whole blocks from the end while each is one repeated byte and that byte is fill. On an
ADFS disc, where the first side has "Hugo" or "Nick" at `&201` (the root directory's mark), fill is any
byte; on every other disc it's `&00` or `&E5` ([why](media-registry-design-notes.md#trimming)).

### Keys from sides

- A side's digest is the SHA-256 of its trimmed bytes, and its side key is the digest cut to 128 bits.
- The disc key is the SHA-256 of the 32-byte side digests in physical order, leaving out trailing sides
  that trimmed to nothing (but always keeping the first), cut to 128 bits. So a DSD whose second side is
  blank has the same disc key as an SSD of its first side.
- A side key is only published when every image known to have that side belongs to one title. If a later
  image shows a published side key is shared, its record becomes an `ambiguous` one, which a client
  treats as no match (or offers the `candidates` as a choice)
  ([why](media-registry-design-notes.md#side-keys)).

### Reference implementation

The spec comes with a reference implementation in JavaScript and C, and test vectors: the same
single-sided disc as a trimmed SSD, a padded SSD and an HFE; a double-sided DFS disc as a DSD and an HFE;
an ADFS L disc as an interleaved image and an HFE; an ADFS M disc padded with `&5A` and unpadded; and a
protected original captured twice, which gives the same key both times.

## Tape fingerprint

1. **Decode** the tape to the bytes it carries: UEF data chunks (`&0100` and `&0104`), or CSW pulses at
   1200 baud.
2. **Find MOS blocks:** `&2A`, a name of up to ten characters and a zero, load and execution addresses,
   block number, length, flags and four spare bytes, a CRC-16 of those, then the data and its CRC.
3. **Assemble files:** consecutive blocks with the same name, numbered up from 0 to one with bit 7 of its
   flags set, make a complete file if none of them has a bad CRC. A block with the same name and header
   as the last block of the most recent file may be a retry, even after that block closed the file: if
   the held copy is bad, a good copy replaces it; if the held copy is good, a bad or identical copy is
   skipped, and a good one with different data is a different block.
4. **Hash** a sequence of records in tape order, and cut the SHA-256 to 128 bits:
   - each complete file gives `&46`, its name and a zero, its load and execution addresses and length
     (32-bit little-endian), then its data;
   - each good block that isn't part of a complete file gives `&42`, its name and a zero, its load and
     execution addresses, its block number (16-bit) and flags, its length (32-bit), then its data;
   - a record identical to the one before it is left out.

Carrier, gaps, baud rate, container chunking and bytes outside MOS blocks don't count
([why](media-registry-design-notes.md#tapes)).

## Records

Every record is a JSON file named `<key>.json`, where the key is a hash or a title slug. Slugs are short,
lowercase and hyphenated (`exile`, `exile-v1-1`) and never 32 hex characters. Every record has `format`
(1) and a `kind`:

| `kind`      | What it is                                         | Key          |
| ----------- | -------------------------------------------------- | ------------ |
| `title`     | a piece of software                                | slug         |
| `version`   | one release of it, with a `parent`                 | slug         |
| `alias`     | one image or copy, with a `parent`                 | any hash key |
| `redirect`  | a slug merged into another, with `to` set to it    | slug         |
| `ambiguous` | a side key shared by several titles (`candidates`) | side key     |

### Chains

Each record's `parent` points one step up, and a chain can be as deep as it needs to be; title, version,
alias is the convention, but an alias can hang straight off a title. A record's metadata is its chain
merged with [JSON Merge Patch (RFC 7396)](https://www.rfc-editor.org/rfc/rfc7396), starting from the
title and applying each record below it in turn, so the record nearest the image wins: objects merge,
anything else replaces, and `null` removes. Any record can set any field. Collections that a record lower
down might change one entry of (`controls.actions`, `links`, `content`, `source`) are objects keyed by a
stable name, not arrays ([why](media-registry-design-notes.md#record-chains)).

```
exile                    title: instructions, controls, links
+-- exile-v1-1           version: its symbols (and nothing else)
    +-- <fingerprint A>  alias: "original, protected"
    +-- <fingerprint B>  alias: "protection removed"
    +-- <file key C>     alias: "the archive's zip of B"
```

### Fields

- **Identity:** `title`, `publisher`, `year`, `authors`, `aliases` (other names), `parent`, and relations
  such as `contains` for a compilation disc.
- **`requires`:** the machine, a second processor, ROMs, 40 or 80 tracks and any other hardware.
- **`boot`:** optional, and usually absent, meaning "do what the disc's boot option says". Only for a
  disc that needs `CHAIN""` or some text typed.
- **`controls`:** `actions`, each with the BBC `keys` that perform it, a label, and optionally a `role`
  (`left`, `right`, `up`, `down`, `fire`, `fire2` and so on). Front ends build touch and gamepad layouts
  from the roles, with anything without a role as a labelled button; host keys and layouts don't go in
  the record.
- **`links`:** pages elsewhere (catalogue entries, disassemblies, inlay scans, homepages), each with a
  `url` and a `rel`.
- **`content`:** material shown inline (instructions, screenshots), each with a `url`, a `source` and a
  `licence`.
- **`source`:** [symbol sets](#symbol-sets).
- **`provenance`:** per field, where its value came from and how.
- **`seenIn`**, **`note`**, **`tags`** on aliases: where an image was found, and how it differs.

### Examples

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
  "links": { "catalogue": { "url": "https://...", "rel": "catalogue" } },
  "provenance": { "controls": { "source": "...", "method": "read from the instructions screen" } }
}
```

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

```json
{ "format": 1, "kind": "redirect", "to": "exile" }
```

```json
{ "format": 1, "kind": "ambiguous", "candidates": ["exile", "citadel"] }
```

## Symbol sets

A symbol set is split into regions, each with anchors: runs of bytes at known addresses that should be
there whenever the region's code is in memory ([why](media-registry-design-notes.md#symbols)).

An anchor is four to eight bytes of whole instructions starting at a routine's entry point. No store
whose target can be worked out may reach any of its bytes (counting the full reach of indexed stores), it
has no run of two or more `NOP`s, and its bytes appear only once in the region. Overlays are separate
regions covering the same addresses. Symbols outside any region (zero page, OS entry points) go in
`globals`; region symbols come from the file at `url`.

```json
{
  "source": {
    "exile-v1-1-labels": {
      "format": "baron-symbols",
      "url": "https://.../exile-v1-1.json",
      "globals": { "lives": "0x70", "osbyte": "0xfff4" },
      "regions": {
        "main": {
          "start": "0x1100",
          "end": "0x5800",
          "minAnchors": 2,
          "anchors": [
            { "at": "0x1a2c", "bytes": "a9008d..." },
            { "at": "0x3391", "bytes": "20b2..." }
          ]
        }
      },
      "licence": "CC0-1.0"
    }
  }
}
```

The debugger checks a region's anchors whenever it's about to show that region (stopped at a breakpoint,
or scrolling the disassembly), and shows its labels only when every anchor matches and there are at least
`minAnchors` of them (default and minimum 1); `globals` show whenever any region matches. A symbol set
without anchors is never shown automatically, but can be picked by hand. With nothing matching, the
debugger shows plain addresses as it does today.

## Stability

Records are sort of immutable. They can grow, but anything a client relies on stays put:

- `format` only changes for something that would break a reader of format 1.
- Fields can be added to any record at any time, and clients ignore fields they don't know.
- A field never changes meaning; removing one is a format change.
- A published key always resolves. A merged slug becomes a `redirect`; a hash key just gets a new parent.
- Files are served with a short cache lifetime and ETags, not as immutable.

## Storage and lookup

The registry is a git repository of JSON files, one per record, published as a static tree (S3, or
bbc.xania.org next to the existing mirrors) with CORS open. Contributions are pull requests. A build step
checks every record against the schema and the [licensing rules](#licensing), and also publishes the
whole lot as one compressed newline-delimited JSON file.

A lookup is `GET <root>/<key>.json`, then the same for each `parent`, following at most a handful of
redirects.

## Licensing

The build step enforces these ([why](media-registry-design-notes.md#licensing)):

- The registry's own data is CC0: keys, hashes, computed facts (sector counts, file lists, load
  addresses), structure and relations.
- Every field that came from somewhere else records its `source` and `licence`. A `content` or `source`
  entry without a licence fails the build.
- Linking is always fine, whatever the licence of the thing linked to.
- Inlining, with attribution, needs a licence that allows redistribution, or the author's permission
  recorded in the entry (a link to where it was given, or when).
- Anything whose licence we don't know is never included. Disc and tape images are never part of a
  record; whether we mirror one is a separate decision about that image.
- Disassemblies without a permissive licence or recorded permission are links only, never symbol sets.
- MAME's software lists (CC0) can be used directly; TOSEC's names and hashes are factual data, used with
  credit; any database without a stated licence is asked first and linked to meanwhile.
- Which keys a game uses is a fact, recorded in `controls` with its source; the text of instructions is
  `content`.

## Filling it in

Sources to start with: our Stairway To Hell mirror, MAME's software lists, TOSEC's names and hashes, the
Bitshifters manifest, and jsbeeb's HFE captures. Other catalogues come after asking.

Aliases are found mechanically, with an LLM on the calls that need judgement, and nothing an automated
pass produces (aliases, keys read off instruction screens, `requires` from boot tests) is published until
a person has approved it ([how and why](media-registry-design-notes.md#finding-aliases)):

1. **Collect** each image's source, keys and decoded file list (DFS, ADFS or tape: names, addresses,
   lengths, a hash per file), reading files by sector address.
2. **Group** equal fingerprints as aliases.
3. **Cluster** images whose shared files make up at least half of each into families, leaving out files
   under 512 bytes or of one repeated byte, and discs that catalogue less than 8K in the rest. When
   shared files make up half of only the smaller image, the bigger one `contains` it.
4. **Judge** each cluster: an LLM, working through tools (a byte diff, the disassembler, a BASIC
   detokeniser, headless jsbeeb), puts each difference into one of: same dump, bad dump, remastered (the
   same files written out again by a tool), disc written to (a later write, a changed cycle number,
   leftover data), protection removed, trainer or cheat, menu or extras added, compilation (with which
   one contains which), another disc of the same set, 40- or 80-track packaging, compatibility fix,
   publisher revision, port, or different software. Every claim must be checkable by a tool, and the
   pipeline checks it again.
5. **Review:** each cluster becomes a pull request of alias records with its evidence and a confidence
   level. A person approves it, and the records' provenance says they were proposed by automated analysis
   and then reviewed.

## Uses in jsbeeb

- The media window shows a title, instructions, screenshots and links, through
  `MediaLoader.addDescriber`.
- `requires` feeds the machine switch that already acts on the Bitshifters `machine` field.
- `controls` roles give phones and tablets a joystick and buttons, and gamepads sensible defaults.
- The debugger labels addresses from symbol sets whose anchors match (#107).
- Snapshots could record the fingerprint next to the file CRC32 they use today, to say what software they
  need, though restoring one mid-load still wants the exact image.
- With no record at all, content heuristics like Clock Signal's can still guess the machine and how to
  boot.

## Open questions

- Title slugs: our own, with MAME's short names and other catalogues' IDs as cross-references, or just
  MAME's names.
- Whether 128 bits is the right key length. The HFE mirror's file-hash names use 64, which may be a bit
  short for a registry other emulators share.
- Whether custom-format tape data (bytes outside MOS blocks) can be decoded consistently enough to
  include.
- Whether a few bytes of duplicator leftovers on a protected track (Philosophers Quest, and perhaps
  Hopper) should split two copies. The key says they're different copies, which is true, so it may be
  fine as long as an alias joins them.
- Where the repository lives and what it's called, so other emulators feel it's theirs as well.
- The `controls` schema, with Robert Smallshire and Beebium.
- Whether, and how, we can host screenshots.

Do let me know what you think, preferably as comments on the PR.

---

This proposal was drafted by Claude (an LLM) with Matt.

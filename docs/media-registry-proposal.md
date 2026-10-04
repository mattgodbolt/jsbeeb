# A media registry for BBC Micro software

A registry lets an emulator work out what software it has just loaded and find out things about it: a
title, instructions, which keys it uses, which machine it needs. A client computes a key from any disc or
tape image, fetches a static JSON record for it, and uses whatever's in it. The registry also holds
symbols for the debugger ([#107](https://github.com/mattgodbolt/jsbeeb/issues/107)), which are found from
the code in memory rather than from the image. Nothing here is implemented yet; this is a proposal to
pick holes in.

This says what to build, in outline. The exact rules are in the design notes, until a reference
implementation and its test vectors take over; `tools/registry/` has a prototype of one. Why it's built
this way, the prior art, and the exact thresholds are in [the design
notes](media-registry-design-notes.md), and the evidence is in [the
findings](media-registry-findings.md).

## Keys

A key is 32 lowercase hex characters, the first 128 bits of a SHA-256, and all keys share one namespace
([why](media-registry-design-notes.md#one-key-namespace)). An image can have a **file key** (the SHA-256
of the file as downloaded), a **disc key** and a **side key** per side, or a **tape key**. A zip has a
file key, and each image inside it is fingerprinted as if it had arrived alone. ROMs just use the file
key.

A client tries the file key, then the disc or tape key, then the side keys in order, and uses the first
record it finds.

## Disc fingerprint

Computed from the disc as loaded, before any writes, one side at a time:

1. **Get the side's bytes.** For a sector image, its bytes in stored order, split into sides by the
   format's track interleave (DSD and ADFS L alternate sides; an `.adf` or `.adm` bigger than an M disc
   is an L). For a flux image, decode each track, keep the sectors with good header and data CRCs
   whatever track their headers claim, and concatenate them ordered by the track they were read from,
   then header track, then sector ID; where an ID repeats with different contents, keep each content
   once, in byte order. A 40-track disc read in an 80-track drive is read from the even tracks only,
   decided per side ([how](media-registry-design-notes.md#reading-flux-captures)). FSD dumps are read the
   same way, with no pitch test ([how](media-registry-design-notes.md#fsd-dumps)).
2. **Trim** trailing 256-byte blocks that are one repeated fill byte, after padding a short last block
   with zeros. The fill byte is `&00` or `&E5`, or any byte on an ADFS disc, which is one whose first
   side has "Hugo" or "Nick" at `&201` ([why](media-registry-design-notes.md#trimming)).
3. **Hash.** A side key is the SHA-256 of the trimmed side, cut to 128 bits. The disc key is the SHA-256
   of the full side digests in order, leaving out trailing sides that trimmed to nothing (but always
   keeping the first), cut the same way.

So the same dump of an unprotected disc gives the same key as an SSD, a padded SSD, an HFE or a zip of
any of them, and a DSD with a blank second side matches an SSD of its first. A side key is published only
while every image known to have that side belongs to one title; when that stops being true, its record
becomes `ambiguous` ([why](media-registry-design-notes.md#side-keys)).

The spec ships with a reference implementation in JavaScript and C and test vectors: one disc as a
trimmed SSD, a padded SSD and an HFE; a double-sided disc as a DSD and an HFE; an ADFS L disc as an image
and an HFE; an ADFS M disc with and without `&5A` padding; and a protected original captured twice,
giving one key.

## Tape fingerprint

A tape (UEF data chunks, or CSW at 1200 baud) is decoded to the blocks the MOS would read. Complete
files, and good blocks that aren't part of one, go into the key in tape order with their names, addresses
and data; carrier, gaps, baud rate and anything outside MOS blocks don't
([details](media-registry-design-notes.md#tapes)).

## Records

A record is a JSON file named `<key>.json`, where the key is a hash or a title slug (short, lowercase,
hyphenated, and never 32 hex characters). Every record has `format` (1) and a `kind`:

| `kind`      | What it is                                                    | Named by     |
| ----------- | ------------------------------------------------------------- | ------------ |
| `title`     | a piece of software                                           | slug         |
| `version`   | one release of it                                             | slug         |
| `alias`     | one image or copy                                             | any hash key |
| `redirect`  | a slug merged into another: `{ "kind": "redirect", "to": … }` | slug         |
| `ambiguous` | a shared side key: `{ "kind": "ambiguous", "candidates": … }` | side key     |

A client treats `ambiguous` as no match, or offers the candidates.

Records chain through `parent`: title, version, alias is the convention, but any depth works. A record's
metadata is its chain merged with [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396) from the
title down, so the record nearest the image wins. Any record can set any field. Collections a lower
record might change one entry of (`controls.actions`, `links`, `content`) are objects keyed by a stable
name, not arrays ([why](media-registry-design-notes.md#record-chains)).

```
exile                    title: instructions, controls, links
+-- exile-v1-1           version: what differs, such as requires
    +-- <disc key A>     alias: "original, protected"
    +-- <disc key B>     alias: "protection removed"
```

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
      "thrust-up": { "keys": ["P"], "role": "up" }
    }
  },
  "links": { "catalogue": { "url": "https://...", "rel": "catalogue" } },
  "provenance": { "controls": { "source": "...", "method": "read from the instructions screen" } }
}
```

The first fields:

- `title`, `publisher`, `year`, `authors`, `aliases` (other names), and relations such as `contains` for
  compilations.
- `requires`: machine, second processor, ROMs, 40 or 80 tracks.
- `boot`: usually absent, meaning use the disc's boot option; only for discs that need `CHAIN""` or
  something else typed.
- `controls`: actions, each with its BBC keys, a label and optionally a `role` (`left`, `up`, `fire`…)
  that front ends turn into touch and gamepad controls. Host keys and layouts stay out of the record.
- `links` to pages elsewhere, and `content` shown inline, each `content` entry with a `source` and a
  `licence`.
- `provenance`: where each field's value came from, and how.
- On aliases, `note`, `tags` and `seenIn`: how this copy differs and where it was found.

### Symbol sets

A symbol set names the addresses of one program, or of programs that are always in memory together. It's
found by its anchors, never by an image's key, so records don't list symbol sets: a known disc, a copy
that's been written to, a crack, a compilation, a cheat disc and a tape that loads the same code at the
same address all find a set the same way.

A set is a JSON file in the registry's own small format, made by a converter from an assembler's output
or a disassembly listing (BeebAsm, Baron, py8dis), and kept in the registry under `symbols/`. Besides
`format` (1), it has a `title` for the debugger to show, its `licence`, its `source` (where the names
came from), optionally the `notice` its licence asks copies to carry, and optionally `madeFrom`, the keys
of the images it was made from, which record where it came from and are never used to find it. Every name
in it is an address; constants stay out. Names are unique within a set, and no address has two names in
one region or in the globals: the converter qualifies local labels with their scope and picks between two
names for one address.

A set has `regions`, each a range of memory (`start` up to but not including `end`, which can be
`0x10000`) with `anchors` (short runs of bytes at known addresses), `minAnchors` and `symbols` (names for
addresses in that range), and `globals`, names not tied to one region's code (zero page, buffers, data it
loads, a table that replaces code once it has run). A region's names show only while every one of its
anchors matches memory and there are at least `minAnchors`. Anchors are read from the memory being looked
at.

A set stores names only when their licence, or their author's recorded permission, allows it. Names it
can't store it can link: `link` holds the `url` of the names' file pinned to an exact version (a commit,
never a branch), the file's `sha256` (the full digest, 64 lowercase hex characters), its `format`, and
`home`, the author's page. A set can have stored names and a link, or a link alone, when it has no
`symbols`, `globals` or `source` and its `licence` covers just its regions and anchors. It has at most
one `link`; any further disassembly of the same code is a plain link in its `links`, as in a record. The
registry never stores linked names. When a set with a link matches, the debugger asks whether to fetch
the linked names, showing the author's `home` and the host the file comes from, and remembers the answer
for that `home` and that host together. If the user agrees, it fetches the file from the author's site,
checks its `sha256`, converts it, and adds the names to the set's: those in a region's range are that
region's, the rest are globals, and stored names win: a linked name for an address the set already names,
or that the set gives to another address, is dropped. So a linked file has to hold only the set's
program. The `url` and `home` are https, a redirect to another host is refused, and the client checks the
file as the build does; a file that fails counts as a failed fetch.

A set's globals name only its own code's operands, except in a system set: a MOS's set marked
`"system": true` (no other set can be one), whose globals (system globals) name its own code's operands
as any set's do, and also every other code's, last, while any of its regions matches, but never an
address inside a matching region of a non-system set. An instruction in one of a set's matching regions
takes names from that set's matching regions, then its globals, then other sets' matching regions, then
system globals if its set isn't the system set; an instruction outside every matching region takes names
from matching regions, then system globals. An address shown on its own, such as a row of the memory
view, takes only that region's names if it lies in a matching region. Otherwise it takes the global that
one non-system set with a matching region names, no name if two or more such sets name it, or a system
global if none does. A breakpoint set by name only stops while its region matches or, for a global, while
any region of its set does.

The debugger shows the names from every set that matches without being asked (linked names once the user
has agreed to the fetch), says which set each name comes from, and lets the user drop a set. Without a
match, it shows plain addresses as it does today ([why, and how regions and anchors are
chosen](media-registry-design-notes.md#symbols)).

Overlays are separate regions over the same addresses, told apart by anchors on bytes where they differ.
The anchor chooser tests every candidate anchor against every title's files in the corpus at the same
address, and every indexed region against the new program, and the pull request that adds a set carries
its report of every title a region matches, with how much of the region that title's files hold and how
much of it is identical there. The reviewer judges each: a region that's all or nearly all identical is
the same code (a crack, a compilation) and the set rightly applies there, while anchors that agree over a
region whose other bytes differ are a collision and need another anchor. If another set already covers
the same code, the two become one shared set. The build checks each set on its own (the schema and
licence, anchor lengths, `minAnchors`, anchors inside their regions, none in `&FC00-&FEFF`, `system` only
on a set in a list of MOS sets that maintainers keep, and a linked file's digest and names) but doesn't
prove two sets apart. If regions of different sets still match at the same address, the debugger shows
neither and offers the choice.

ROMs have sets too, one for each version of a MOS, BASIC, DFS or ADFS. Nothing writes to a ROM, so its
anchors can sit anywhere but `&FC00-&FEFF`, and its regions are cut where a machine can put RAM or I/O
over part of it. On the BBC Micro, the Master, the Compact and the Electron, no region covers the I/O at
`&FC00-&FEFF`; the Master's and the Compact's MOS are cut at `&E000` because HAZEL can be paged over
`&C000-&DFFF`; and a sideways ROM is cut at `&9000` and `&B000` because the Master's ANDY can be paged
over `&8000-&8FFF` and the B+'s RAM over `&8000-&AFFF` ([why](media-registry-design-notes.md#roms)).

The build publishes `symbols/index.json`: every set's `url` (relative to the index), `licence`, `link` if
it has one, and its `regions` with their anchors but without their `symbols`. The debugger fetches the
index when it first wants names, checks every indexed region each time the machine stops, and fetches
only the sets that match ([how](media-registry-design-notes.md#finding-sets-by-their-anchors)).

```json
{
  "format": 1,
  "title": "Exile v1.1: the game",
  "licence": "CC0-1.0",
  "source": "https://...",
  "madeFrom": ["<disc key A>"],
  "globals": { "player_x": "0x70" },
  "regions": {
    "main": {
      "start": "0x1100",
      "end": "0x5800",
      "minAnchors": 2,
      "anchors": [
        { "at": "0x1a2c", "bytes": "a9008d..." },
        { "at": "0x2e40", "bytes": "20eeff..." }
      ],
      "symbols": { "main_loop": "0x1a2c" }
    }
  }
}
```

A linked set:

```json
{
  "format": 1,
  "title": "Some game: the main code",
  "licence": "CC0-1.0",
  "link": {
    "url": "https://raw.githubusercontent.com/<owner>/<repo>/<commit>/game.lst",
    "sha256": "<the file's SHA-256>",
    "format": "beebasm-listing",
    "home": "https://github.com/<owner>/<repo>"
  },
  "regions": {
    "main": {
      "start": "0x1900",
      "end": "0x5800",
      "minAnchors": 2,
      "anchors": [
        { "at": "0x1a2c", "bytes": "a9008d..." },
        { "at": "0x2e40", "bytes": "20eeff..." }
      ]
    }
  }
}
```

## Stability and hosting

Records can grow but don't break: `format` changes only for something that would break a format 1 reader,
new fields can appear anywhere and clients ignore ones they don't know, fields never change meaning or
disappear, and a published key always resolves (a merged slug becomes a `redirect`; a hash key just gets
a new parent).

The registry is a git repository of JSON files, published as a static tree (S3, or bbc.xania.org) with
CORS open, short cache lifetimes and ETags. Contributions are pull requests, and a build step checks
every record against the schema. A lookup is `GET <root>/<key>.json`, then the same for each `parent`,
following a `redirect`'s `to` (at most a handful of times).

## Licensing

A build step enforces these ([why](media-registry-design-notes.md#licensing)):

- Our own data (keys, computed facts, relations) is CC0.
- Anything from elsewhere records its `source` and `licence`; `content` or a symbol set without a licence
  fails the build.
- Linking is always fine. Inlining, with attribution, needs a licence that allows it, or the author's
  recorded permission. Anything of unknown licence, and any disc or tape image, is never included.
- Which keys a game uses is a fact; the text of its instructions is content.
- A symbol set stores names from someone else's work only under a licence or recorded permission that
  allows it; otherwise it links them where it can, and where it can't, or the author has refused reuse, a
  record or a set links to the work. Sources under the GPL aren't used for sets, stored or linked, though
  a record or a set can link to them.

## Filling it in

We start from our Stairway To Hell and HFE mirrors, MAME's software lists, TOSEC and the Bitshifters
manifest; other catalogues after asking. Equal keys are aliases. Beyond that, images are clustered by the
files they share, an LLM judges how the images in each cluster differ using tools whose output can be
checked, and each cluster becomes a pull request that a person reviews. Nothing automated (aliases,
controls read off screens, `requires` from boot tests) is published without that review, and its
provenance says so ([how](media-registry-design-notes.md#finding-aliases)).

## Uses in jsbeeb

The media window shows a title, instructions and links through `MediaLoader.addDescriber`; `requires`
feeds the existing machine switch; `controls` gives phones a joystick and gamepads sensible defaults; the
debugger labels code from matching symbol sets (#107). With no record, content heuristics like Clock
Signal's can still guess the machine.

## Open questions

- Title slugs: our own, or MAME's short names.
- Whether 128 bits is the right key length.
- Whether tape data outside MOS blocks can be decoded consistently enough to include.
- Whether a few bytes of duplicator leftovers on a protected track (Philosophers Quest, perhaps Hopper)
  should split two copies, or whether an alias joining them is enough.
- Where the repository lives and what it's called, so other emulators feel it's theirs too.
- The `controls` schema, with Robert Smallshire and Beebium.
- Whether, and how, we can host screenshots.

Do let me know what you think, in a [GitHub issue](https://github.com/mattgodbolt/jsbeeb/issues) or on [the PR that proposed this](https://github.com/mattgodbolt/jsbeeb/pull/1179).

---

This proposal was drafted by Claude (an LLM) with Matt.

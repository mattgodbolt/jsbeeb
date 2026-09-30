# A media registry for BBC Micro software

A registry lets an emulator work out what software it has just loaded and find out things about it: a
title, instructions, which keys it uses, which machine it needs, symbols for the debugger
([#107](https://github.com/mattgodbolt/jsbeeb/issues/107)). A client computes a key from any disc or tape
image, fetches a static JSON record for it, and uses whatever's in it. Nothing here is implemented yet;
this is a proposal to pick holes in.

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
record might change one entry of (`controls.actions`, `links`, `content`, `source`) are objects keyed by
a stable name, not arrays ([why](media-registry-design-notes.md#record-chains)).

```
exile                    title: instructions, controls, links
+-- exile-v1-1           version: its symbols
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
- `source`: symbol sets (below).
- `provenance`: where each field's value came from, and how.
- On aliases, `note`, `tags` and `seenIn`: how this copy differs and where it was found.

### Symbol sets

A symbol set comes from a file (Baron's `--symbols` JSON, say), split into address regions. Each region
has anchors, short runs of bytes at known addresses, and the debugger shows a region's labels only while
all of its anchors match memory, and there are at least `minAnchors`. Symbols outside any region go in
`globals`. Without matching anchors, the debugger shows plain addresses as it does today ([why, and how
anchors are chosen](media-registry-design-notes.md#symbols)).

```json
{
  "source": {
    "exile-v1-1-labels": {
      "format": "baron-symbols",
      "url": "https://.../exile-v1-1.json",
      "globals": { "osbyte": "0xfff4" },
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
- Anything from elsewhere records its `source` and `licence`; `content` or `source` without a licence
  fails the build.
- Linking is always fine. Inlining, with attribution, needs a licence that allows it, or the author's
  recorded permission. Anything of unknown licence, and any disc or tape image, is never included.
- Which keys a game uses is a fact; the text of its instructions is content.

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

Do let me know what you think, preferably as comments on the PR.

---

This proposal was drafted by Claude (an LLM) with Matt.

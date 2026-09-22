# Media sources

A media source is somewhere the media window can list discs from and load them. Each one is a
pair of functions keyed by a URL schema: a lister that describes what the source holds, and a
fetcher that returns the bytes of one entry. The window, the URL parameters, the headless
session and the MCP server all go through the same two.

## What a source hands the window

Every listed entry is one descriptor, whichever source it came from:

```js
{ ref, kind, title, publisher, detail, source, savesChanges, url?, requires? }
```

- `ref` is what `loadDiscImage` or `loadTapeImage` takes and what goes in the URL, schema
  included: `bitshifters:bs-paradroid.ssd`, `hfe:c0ced89b14aaef23.hfe`, `sth:Elite.zip`.
- `kind` is `disc` or `tape`.
- `title`, `publisher` and `detail` are what the row shows and what the search matches; `detail`
  is free text, joined with `·` when it has several parts.
- `source` is a key of `Sources` in `src/web/media-catalogue.js`, which gives the chip's name,
  the phrase used mid-sentence in a slot's status line, and a tooltip.
- `savesChanges` says whether writes to the disc go back to the source.
- `url`, when present, is a page about the entry. The window renders it as a link only when it
  parses as an `http` or `https` URL; a source's manifest is not trusted further than that.
- `requires`, when present, is the machine a disc needs, as `{ model, coProcessor, name }`:
  `model` a synonym from `src/models.js`, `coProcessor` whether a Tube is fitted, `name` what the
  user is told. `machineRequirement(name)` in `media-catalogue.js` maps a manifest's machine name
  to one through the table `MachineRequirements`, and a name outside the table gives no
  requirement.

The functions that build descriptors (`describeBuiltIn`, `describeHfeEntry`,
`describeBitshiftersEntry` and so on) live in `media-catalogue.js`, along with `SourceRank`,
which orders sources holding the same title: the user's own discs first, then the sources with
metadata (the authors' own releases, the flux captures), then the sources without.

## Schemas and routes

`Schemas` in `src/media-resolver.js` maps every prefix a reference can start with to how it is
served (`route`) and which source it counts as. A reference with no schema is a bare name from
the built-in folder. Archive sources register their fetcher with `MediaResolver.addSource(schema,
fetcher)`, and a route that is just "bytes by path" (`hfe`, `bitshifters`) needs nothing more than
its `case` in `resolve`.

## The Bitshifters manifest

`https://bitshifters.github.io/content/manifest.json` is
`{ schemaVersion, generated, files: [...] }`, with one object per disc:

```json
{
  "path": "bs-paradroid.ssd",
  "title": "Paradroid",
  "publisher": "Bitshifters",
  "authors": "Ported by Kieran ...",
  "year": 2026,
  "type": "Game",
  "machine": "Master",
  "url": "https://bitshifters.github.io/posts/prods/bs-paradroid.html"
}
```

The disc itself is at `https://bitshifters.github.io/content/<path>`. `authors` is optional;
`publisher` is not always Bitshifters, and a publisher or author may carry HTML, which is
stripped. Both the manifest and the discs are served with `Access-Control-Allow-Origin: *`,
which any remote source needs, since the browser fetches them cross-origin.

`machine` is the machine the disc needs: `Master` is the Master 128 with DFS and no Tube,
`MasterTurbo` the same with the 65C102 co-processor. Any other field we come to read, or need
the manifest to gain, is documented here in the same change that starts reading it.

## Adding a source

1. An archive class in `src/`, headless and free of DOM: it fetches and caches the catalogue and
   returns the bytes for a path. `src/bitshifters.js` is the smallest example.
2. In `src/web/media-catalogue.js`: an entry in `Sources` (name, phrase, title), a
   `describe...Entry` that turns one catalogue entry into a descriptor, and a rank in
   `SourceRank`.
3. In `src/media-resolver.js`: the schema in `Schemas`, and a `case` in `resolve` if an existing
   route does not fit.
4. A source class in `src/web/` that constructs the archive and registers both halves:
   `media.addSource(schema, fetcher)` and `media.addLister(source, lister)`. A source whose
   entries can carry `requires` also registers `media.addDescriber(source, (path) => descriptor)`,
   so a link that boots one of its discs can find the requirement without listing the catalogue.
5. Wiring: construct the source in `src/main.js` beside the others, and register the fetcher in
   `src/machine-session.js` so the headless session and the MCP server can load its references.
6. The README's list of `disc=` forms, and a mention in the media window paragraph.
7. Tests: the archive (`fetch` stubbed with `vi.spyOn`, restored after each test), the source's
   registration, the descriptor in the catalogue tests, the schema in the resolver tests, and any
   new row behaviour in the media window tests.

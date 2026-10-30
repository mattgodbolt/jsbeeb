# Media sources

A media source is somewhere the media window can list discs from and load them. Each one is a
pair of functions keyed by a URL schema: a lister that describes what the source holds, and a
fetcher that returns the bytes of one entry. The window, the URL parameters, the headless
session and the MCP server all go through the same two. GitHub has no fetcher of its own, since
its references are URLs by another name (see [GitHub](#github)). The `rom` and `rom.N` URL
parameters load sideways ROMs through the same resolver, as its `rom` kind: a bare name from
`roms/`, a URL, a `github:` reference or inline data, but none of the archives.

## What a source hands the window

Every listed entry is one descriptor, whichever source it came from:

```js
{ ref, kind, title, publisher, detail, source, savesChanges, url?, requires? }
```

- `ref` is what `loadDiscImage` or `loadTapeImage` takes and what goes in the URL, schema
  included: `bitshifters:bs-paradroid.ssd`, `hfe:c0ced89b14aaef23.hfe`, `sth:Elite.zip`,
  `github:mattgodbolt/nm/ninja_music.ssd`.
- `kind` is `disc` or `tape`.
- `title`, `publisher` and `detail` are what the row shows and what the search matches; `detail`
  is free text, joined with `·` when it has several parts.
- `source` is a key of `Sources` in `src/web/media-catalogue.js`, which gives the chip's name,
  the phrase used mid-sentence in a slot's status line, a tooltip, and whether it is `personal`
  (the user's own media, which analytics names only by its source).
- `savesChanges` says whether writes to the disc go back to the source.
- `url`, when present, is a page about the entry. The window renders it as a link only when it
  parses as an `http` or `https` URL; a source's manifest is not trusted further than that.
- `requires`, when present, is the machine a disc needs, as `{ model, coProcessor, name, needs, fittings }`:
  `model` a synonym from `src/models.js`, `coProcessor` whether a Tube is fitted, `name` the
  machine's name for the user, `needs` the names of the fittings it needs beyond that and
  `fittings` the settings that fit them (`{ hasVideoNula: true }`). `requirementName` in
  `media-catalogue.js` says the whole requirement to the user, on the running model when there is
  no `model` (and so no `name`).
  `requirementOf(entry)` in `media-catalogue.js` builds it from a manifest entry's `machine`, through
  the table `MachineRequirements`, and its `needs`, through the `neededAs` names of the entries in
  `src/web/parameters.js`. A name in neither table counts for nothing, so an entry whose `machine`
  is unknown and whose `needs` are known requires the fittings alone. With no `model` the
  machine switch keeps the model it has.

The functions that build descriptors (`describeBuiltIn`, `describeHfeEntry`,
`describeBitshiftersEntry` and so on) live in `media-catalogue.js`, along with `SourceRank`,
which orders sources holding the same title: the user's own discs first, then the sources with
metadata (the authors' own releases, the flux captures), then the sources without.

With the search box empty, the window lists what was loaded most recently first, under a heading.
`RecentMedia` in `media-catalogue.js` keeps the eight newest references in the browser's storage,
and up to eight files opened this session alongside them for the visit; `MediaSlots` notes every
load, but not a restored state's media or what the page starts with (the default disc, or what the
URL names). The media window notes a disc that needs another machine before the page reloads as
that machine, and a load the user asks for again (Retry, or connecting Google Drive) counts.

## Schemas and routes

`Schemas` in `src/media-resolver.js` maps every prefix a reference can start with to how it is
served (`route`) and which source it counts as. A reference with no schema is a bare name from
the built-in folder. Archive sources register their fetcher with `MediaResolver.addSource(schema,
fetcher)`, and a route that is just "bytes by path" (`hfe`, `bitshifters`) needs nothing more than
its `case` in `resolve`. A route that only rewrites the reference as a URL (`github`) loads it the
way the `url` route does and registers nothing, so every resolver can load it.

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
`MasterTurbo` the same with the 65C102 co-processor. `needs`, which jsbeeb reads but the
manifest does not carry yet, is a list of the fittings the disc needs beyond its machine, by the
`neededAs` names in `src/web/parameters.js`: `["VideoNuLA"]` for a disc that needs a VideoNuLA.
Any other field we come to read, or need the manifest to gain, is documented here in the same
change that starts reading it.

## GitHub

`github:<owner>/<repo>/<path>` names a file committed to a public GitHub repo, at its default
branch: `github:mattgodbolt/frogman/frogman_rebuilt.ssd`. `@<ref>` after the repo name picks a
branch, tag or commit instead: `github:mattgodbolt/frogman@classic/frogman_rebuilt.ssd`. A ref
has no `/` in it. The resolver loads `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
(with `HEAD` as the ref when none is given), encoding each segment of the path, and opens a zip
as it would one from a URL. raw.githubusercontent.com sends `Access-Control-Allow-Origin: *`, and
caches for five minutes, so a push takes up to that long to show.

`@~latest` is the tag of the repo's latest GitHub Release:
`github:mattgodbolt/chuckie-egg-2-beeb@~latest/chuckie-egg-2.ssd` follows releases rather than every
push. The resolver asks `https://api.github.com/repos/<owner>/<repo>/releases/latest` (which sends
`Access-Control-Allow-Origin: *`) for its `tag_name`, then loads the file committed at that tag as
above. `~` cannot appear in a git ref name, so `~latest` cannot collide with a real branch or tag.
The API skips drafts and prereleases, and a bare tag is not a Release; a Release with no assets is
enough. Unauthenticated calls are limited to 60 an hour per IP, so the answer is kept for the rest
of the session, one call per repo. If the call fails, the rate limit included, the resolver warns
on the console and loads the default branch instead, for the rest of the session.

A GitHub release asset cannot be loaded: its download is a redirect from github.com with no CORS
header, so the browser refuses it, and the disc has to be committed to the repo instead (at the
release's tag, for `@~latest`). A GitHub Pages site does send the header, so a disc published there
loads as a plain `https:` URL.

The media window lists the discs in `src/web/github-discs.json`, which is bundled into the page
when it is built, so the list itself has nothing to fetch. Each entry has the Bitshifters
manifest's fields, with `repo` and `ref` in place of the site:

```json
{
  "repo": "mattgodbolt/nm",
  "path": "ninja_music.ssd",
  "title": "Ninja Massacre music",
  "publisher": "Matt Godbolt",
  "authors": "Music by David Whittaker",
  "year": 2026,
  "type": "Music",
  "machine": "Master"
}
```

- `repo` is `owner/name` and `path` is the file within it. `title`, `publisher`, `year` and
  `type` are required.
- `ref` is optional. Without it the entry follows the default branch, so it always loads the
  latest build. The cost: a broken push breaks it until the next push fixes it, and a save state
  made with it stops restoring once a new build is pushed, because a state will not restore over
  a disc that has changed since it was saved. `"ref": "~latest"` follows releases instead, with
  the same cost at each new release.
- `authors` is optional, and plain text.
- `machine` is optional, and takes the names `MachineRequirements` knows, as the Bitshifters
  manifest's does.
- `needs` is optional, and lists fittings by the names the Bitshifters manifest's `needs` takes.
- `url` is optional and defaults to the repo's page, `https://github.com/<repo>`.

The entry is listed as `github:<repo>/<path>`, or `github:<repo>@<ref>/<path>` when it has a ref.
A link that boots it finds its `machine` only when the link spells the reference that way: the
same disc named with `@main`, say, loads but is not switched to the machine it needs.
`tests/unit/test-archive-sources.js` checks every entry's fields, and that no two entries name the
same disc.

## Adding a source

1. An archive class in `src/`, headless and free of DOM: it fetches and caches the catalogue and
   returns the bytes for a path. `src/bitshifters.js` is the smallest example.
2. In `src/web/media-catalogue.js`: an entry in `Sources` (name, phrase, title, and `personal`
   when it holds the user's own media rather than a public catalogue), a
   `describe...Entry` that turns one catalogue entry into a descriptor, and a rank in
   `SourceRank`.
3. In `src/media-resolver.js`: the schema in `Schemas`, and a `case` in `resolve` if an existing
   route does not fit. A schema with no source is marked `personal` there instead.
4. In `src/web/archive-sources.js`, `addArchiveSources` constructs the archive and registers both
   halves: `media.addSource(schema, fetcher)` and `media.addLister(source, lister)`. A source whose
   entries can carry `requires` also registers `media.addDescriber(source, (path) => descriptor)`,
   so a link that boots one of its discs can find the requirement without listing the catalogue.
5. Register the fetcher in `src/machine-session.js` too, so the headless session and the MCP server
   can load its references. A source whose route needs no fetcher, as GitHub's does not, has
   nothing to register there.
6. The README's list of `disc=` forms, and a mention in the media window paragraph.
7. Tests: the archive (`fetch` stubbed with `vi.spyOn`, restored after each test), the registration in
   `test-archive-sources.js`, the descriptor in the catalogue tests, the schema in the resolver tests, and any
   new row behaviour in the media window tests.

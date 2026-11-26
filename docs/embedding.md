# Embedding jsbeeb

## Design

### Link

Parameters go in the query or the fragment of a `bbc.xania.org` URL. A flag may be bare, `=true` or `=false`.

- Stable parameters: `disc`/`disc1` (drive 0), `disc2` (drive 1), `tape`, `model`, `autoboot`, `autochain`, `autorun`,
  `loadBasic`, `embedBasic`, `autotype`, `coProcessor`, `rom`, `rom.N`, `KEY.x`, `GP.x`, `noseek`, `displayMode`,
  `keyLayout`, `embed`, `mmc`, `mute`, and for the player `start` and `attribution`. Each is marked `stable: true` in
  `Parameters`, which this list is checked against.
- Media: a built-in name, `https:`/`http:`, `github:`, `sth:` (or `|`), `bitshifters:`, `hfe:`, `data:`, `b64data:`.
- `rom.N` may replace a model's own ROMs.

### Frame: `/player/`

```html
<iframe
  src="https://bbc.xania.org/player/?disc=https://example.org/game.ssd&autoboot"
  allow="autoplay; fullscreen; gamepad"
></iframe>
```

- The screen only. One click starts sound and takes the keys; `start=auto` skips it, leaving sound and keys to
  `audiostate` and `focus`.
- Never opens a dialog or reloads. No storage, no service worker. Analytics: a count of starts per embedding site.
- Reports unknown or refused parameters, on screen and as a `notice`.
- A corner link back to the full site; `attribution=off` hides it.
- `?embed` on the full site redirects here client-side, keeping the query and fragment.
- `postMessage`, protocol version 1. Methods: `loadDisc`, `ejectDisc`, `loadTape`, `loadBasic`, `type`, `reset`,
  `start`, `pause`, `focus`, `snapshot`, `restore`. Events: `ready`, `notice`, `error`, `audiostate`.
  `connectPlayer(iframe)` from `jsbeeb/player-client` wraps them.

### Library: `jsbeeb/web`

```js
const beeb = await createBeeb({ canvas, model: "Master", media: { disc1: url }, boot: "disc" });
await beeb.keyboard.type("RUN\r");
```

- `beeb`: `start`, `pause`, `reset`, `snapshot`, `restore`, `screenshot`, `focus`, `destroy`. Events: `notice`,
  `error`, `audiostate`, `lights`.
- Facets: `keyboard`, `media`; later `memory`, `debug`, `hardware`, as asked for. `MachineSession` drives the same
  facets.
- Touches no storage, URL, service worker or analytics. Listens only on the element it is given.
- Several machines per page; `destroy()` leaves nothing behind.
- Assets resolve via `import.meta.url`; `assets` overrides.
- Ships types and a prebuilt bundle (no bundler needed). The on-screen keyboard is a separate reusable part.
- `beeb.processor` is an escape hatch with no promise. Owlet is the first consumer.

### Guarantees

- Kept, with tests: the stable parameters and media forms, the `bbc.godbolt.org` redirect, the exports of `jsbeeb`,
  `jsbeeb/web`, `jsbeeb/player-client` and `jsbeeb/machine-session` with their types, protocol version 1, and every
  documented snapshot version.
- Not kept: `jsbeeb/src/*`, `beeb.processor`, tuning and debug parameters, cycle-exact replay across versions, the
  full site's look.
- One npm package. A break takes `!` and a major. Something deprecated warns and lasts until the next major. Changes
  are announced on a pinned issue.
- Bundling jsbeeb brings the GPL; framing it does not.

## Steps

- [x] This doc
- [ ] `stable: true` in `Parameters`, checked against the list above; deprecated parameters warn
- [ ] Contract test: real link shapes boot to a known screen, an HTTP check that `bbc.godbolt.org` still redirects,
      every documented snapshot version restores
- [ ] `createBeeb` tier 1: lifecycle, `keyboard`, `media`, events, `assets`, nothing Node-only in the browser path,
      `MachineSession` on the same facets
- [ ] Types, plus a test that snapshots the public API
- [ ] Consumer test: `npm pack` into `examples/embed-vite`, build, boot two machines, destroy one
- [ ] Leak test: create and destroy many times
- [ ] Replacing a model's own ROMs, in config and URL
- [ ] Prebuilt bundle in the npm package
- [ ] Owlet imports nothing from `jsbeeb/src`
- [ ] `/player/` and `examples/embed.html`
- [ ] Messages, `connectPlayer`, cross-origin test
- [ ] `?embed` redirects to `/player/`
- [ ] Reusable on-screen keyboard
- [ ] Pinned "Embedding: changes" issue; tell bbcmicro.co.uk
- [ ] Remove this section; retitle "How to embed jsbeeb"

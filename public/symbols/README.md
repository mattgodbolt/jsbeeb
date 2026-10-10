# Symbol sets

Names the debugger shows in place of addresses, in the format "Symbol sets" in
[the media registry proposal](../../docs/media-registry-proposal.md) describes. jsbeeb fetches `index.json` the
first time the debugger wants names, then each set whose anchors match memory. None of it is bundled into the
emulator, so the data can move to the registry by changing the base URL in `src/main.js`.

**None of this data is under jsbeeb's GPL.** Each set says under which licence its names are used in its own
`licence`, where they came from in `source`, and carries any `notice` its licence asks copies to keep.

- `sets/`: the sets, one JSON file each.
- `mos-sets.json`: the sets that may be marked `"system": true`. Only a MOS's set belongs on it.
- `index.json`: made from the sets; never edited by hand.

After changing a set, check the sets and remake the index:

```sh
node tools/symbols/build-index.js
```

`sets/bbc-b-mos-1.20.json` is made from py8dis's
[acorn.py](https://github.com/ZornsLemma/py8dis/blob/5da0ecb47c54ff5afe62a8e62c03eca4ec42ccac/py8dis/acorn.py),
at the commit `tools/symbols/make-mos-set.js` names, and `public/roms/os.rom`. Remaking it needs python3:

```sh
node tools/symbols/make-mos-set.js && node tools/symbols/build-index.js
```

The `pipeline-*.json` sets are imported from PIPELINE's baron build by `tools/symbols/import-baron.js`, as
`symbols-src/pipeline.json` describes; [the importers' doc](../../docs/symbol-importers.md) says how to remake and
check them.

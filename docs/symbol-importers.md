# Symbol set importers

How the symbol sets under `public/symbols/sets/` are made from a title's own build. The format is "Symbol
sets" in [the media registry proposal](media-registry-proposal.md); this is how a curator gets from a source
repository to a set in that format.

## The idea

A source repository never changes for jsbeeb. It builds as it always does: baron with `--symbols` and `-vv`,
BeebAsm with its own outputs, or a published disassembly listing. jsbeeb's tools then import that output, so
nobody has to emit jsbeeb metadata.

The curator's job lives here, beside the sets: which programs make a set, where a program's memory changes
while it runs (so where its regions are cut), and the anchors that tell the program apart in memory. Each
input format gets an importer, and every importer feeds one anchor chooser and the index's checks.

| Piece                             | What it does                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tools/symbols/baron-listing.js`  | Reads one baron `-vv` listing: sections, statements and their bytes, labels, `=` names and scopes        |
| `tools/symbols/import-baron.js`   | The baron importer: names from the listings, cross-checked against the `--symbols` dump; writes the sets |
| `tools/symbols/anchor-chooser.js` | Chooses each region's anchors from what an importer read; shared by every importer                       |
| `tools/symbols/corpus-check.js`   | The corpus check a set's pull request carries                                                            |
| `tools/symbols/check-memory.js`   | Checks the sets against the title running in a headless jsbeeb, at moments the curator picks             |
| `tools/symbols/build-index.js`    | Checks every set as the registry's build will, and writes `index.json`                                   |
| `symbols-src/<title>.json`        | A curator's config for one title                                                                         |
| `symbols-src/<title>-check.js`    | That title's moments for the in-memory check                                                             |

## A title's config

`symbols-src/<title>.json` names the title's sets and says where each is cut, in the source's own names.
Nothing in it is an address list: the names come from the build.

- `id`: the prefix of the title's set files, `<id>-<set id>.json`.
- `licence`, `notice`, `madeFrom`: copied into every set.
- `source`: the `repository` and the `commit` that was built. The importer, the corpus check and the in-memory check refuse a
  build directory that isn't in a git checkout of that commit with nothing changed or added, and each set's
  `source` links the tree at that commit. They can't tell a build left over from another commit; the source
  repository's own build keeps that true.
- `build`: where in the build directory the importer finds the symbol dump, the `-vv` listings (one per
  source, `<source>.txt`), the built files with their `.inf` sidecars, and the disc the in-memory check boots.
- `leftToSystemSets`: INCLUDEd files whose names a system set (the MOS's) already gives. The listing doesn't
  mark where an INCLUDE ends, so these are the `=` names it shows straight after the INCLUDE line, before
  any other line.
- `bytesPerAnchor`, `spreadAnchors`: at least one anchor per this many bytes of a region, up to this many,
  before the anchors that tell other programs apart.
- `check`: the module of scenarios for the in-memory check, beside the config.
- `sets`: each with an `id`, a `title`, the `sources` that make it, and its `regions`. A set can also have:
  - `stripScope`: a scope that wraps the whole program, left off its names;
  - `tableSizes`: tables written with an index, by name, with how far the index goes (an expression);
  - `moves`: labels of the copies that put the program in place, whose stores don't keep anchors off what
    they copy;
  - `globalsSections`: sections whose labels are the program's globals (zero page, say, which holds no code
    and which every program writes, so a region there couldn't be anchored).
- A region is a SECTION (`section`, in `source` if not the set's first), or part of one between `from` and
  `to`, expressions in the source's names (`pl.encrypted - 1`, `menu_screen + &700`). It can also have:
  - `overwritten`: run-once code that something else writes over when it's done, so only its own stores
    keep anchors off its bytes;
  - `avoid`: `[from, to)` ranges no anchor may cover, beyond what the chooser finds itself.

## Running it

For a baron title, build it as its repository does, including a `-vv` listing per source (plain `-v` cuts a
statement's bytes at eight, so it can't be read for them), then:

```sh
node tools/symbols/import-baron.js --config symbols-src/pipeline.json --build ../pipeline-disasm/build
node tools/symbols/build-index.js
node tools/symbols/corpus-check.js --config symbols-src/pipeline.json --build ../pipeline-disasm/build \
    --corpus .registry-corpus/sth-disc
node tools/symbols/check-memory.js --config symbols-src/pipeline.json --build ../pipeline-disasm/build
```

The importer writes nothing if a region can't be anchored, if its anchors all match another of the build's
images, if a set fails the index's checks, or if the build directory isn't in a clean checkout of the config's commit. `--verbose` lists
every name left out, and why, and every anchor added to tell another image apart. The in-memory check takes
scenario names to run only those, and `--shots DIR` to save the screenshots a scenario asks for.

## Names

- **Labels** go to the region of the section they're assembled in, qualified with their scopes
  (`select_sprite.down_not_0f`), less the set's `stripScope`. A label at a section's exclusive end
  (`main_code_end`) is in no region and is left out. A label inside an anonymous scope (baron's `@` names) is
  never used.
- **`=` names** count as addresses when an instruction uses them as a memory operand: the operand's first
  name, not after `#`, not a FUNCTION's result, and not one `leftToSystemSets` covers. Such a name goes to
  the region it points into if only that region's code uses it, and is a global otherwise.
- **One name per address.** In a region, a scope's own name wins over the labels inside it (`pl` over
  `pl.start`), then the label written last, nearest the bytes (`tune` over `sound_data`). In the globals,
  the `=` name the most instructions use, over any label of a `globalsSections` section.
- Every label the listing gives has to agree with the symbol dump, or the importer stops: the dump is what
  baron resolved, and the listing is where the scopes, sections and bytes come from.

## Anchors

Candidates are runs of 4 to 8 bytes of the region's own statements: whole instructions from an
instruction's start (aiming for 6 bytes), or data from any byte. A candidate is out if any of its bytes is:

- reached by a store whose target the instruction gives (an indexed store reaches 256 bytes, or all of zero
  page, unless `tableSizes` gives the table's size), except that a run-once region only minds its own
  stores, and the copies in `moves` don't count;
- in a block the code hands the OS (`LDX #LO(block)`), which OSWORD, OSFILE and OSGBPB write results into:
  from its label to the next one that starts code or another block, 18 bytes at most;
- SKIP padding, or under a label the source names as dead or leftover (`unused`, `leftover`, `junk`,
  `spare`, `stray` as a word of any of its scopes), up to the next label;
- in a BASIC program (a section saved to run at `&8023`), its first line, any line's CR, number and length,
  or a REM's text (but for code in the REM);
- in `&FC00-&FEFF`, or in an `avoid` range;

or if the run calls into the MOS (`JSR` or `JMP` to `&C000` up: code every program shares), has two NOPs
together (where cheats poke), has fewer than four different bytes, or appears twice in the region.

From those, about one anchor per `bytesPerAnchor` of the region (`spreadAnchors` at most), spread over it,
preferring a label, then code, then the most different bytes. Then, for every other image of the region's
addresses in the build (every section of every source where it runs, every file where it loads):

- an image that holds all the anchors and agrees with them gets another anchor where it differs, or the
  importer fails;
- another program's image of any part of the region gets an anchor inside that part where it differs, if
  there is one, which is what makes a leftover stop matching once part of it is overwritten. When there
  isn't one, the importer says so as a note.

## The checks

- **The corpus check** places every complete DFS file on every disc in the corpus at its load address and
  lists, for each region, every title whose files hold all its anchors, with how much of the region they
  hold and how much of that is identical. 90% identical or more is the same code (a crack, a compilation);
  anything less is a collision, and the check exits 1. Files sit at their load addresses, so code a program
  moves to where it runs is only compared with other titles' files that load there.
- **The in-memory check** boots the title's disc and, at each moment a scenario picks, lists the regions
  whose anchors all match. A moment fails unless that's exactly the regions expected, and if two matching
  regions overlap, of one set or two, since the debugger then shows neither.

## What the baron importer gets wrong, or only roughly

- **One program's zero page used differently in different regions** loses names, since a set's globals hold
  one name per address: PIPELINE's game loader's `copy_return`, `copy_from` and `menu_keys` give way to the
  main code's `monster_x`, `monster_direction` and `work0`.
- **The operand rule misses** addresses the code reaches only through an immediate's `LO()`/`HI()`, through
  a FUNCTION, or through a table of addresses, and takes a name whose instruction is dead code as readily as
  any.
- **Stores it can't see** stay unseen: through a pointer, or by the OS into blocks it was passed other than
  with `LDX #LO(...)`. The `LDX #LO(...)` rule also over-blocks: it takes OSCLI strings, which the OS only
  reads.
- **Hand-written knowledge** sits in the config, by name: where to cut the regions, the table sizes, the
  moving copies. A change to the code that moves those needs the config looked at; a misspelt name stops
  the import.
- **The "another program's image" rule** adds anchors for meetings that never happen: PIPELINE's MISSION
  gets one in TITLE's unpacker page and one in the game's loader, which no route through the menu puts
  beside it.
- **Data anchors in text** land wherever the spread puts them; nothing makes them better than any other
  text.

What baron's output can't give the importer, and how it copes:

- **The symbol each operand was written with**, and each instruction's address, as data
  ([baron#14](https://github.com/waitingforvsync/baron/issues/14)): the importer reads operands back out of
  the `-vv` listing's text, which is why it needs the per-source `-vv` listings and can't follow a FUNCTION.
- **Each symbol's kind (a label, an address, a constant) and the section a label was emitted in**
  ([baron#15](https://github.com/waitingforvsync/baron/issues/15)): the importer takes a label's section
  from where the listing shows it, and an `=` name as an address only when an instruction uses it as one.
- **A table's size, and where the OS or a pointer writes**: nothing in the build says these, so the config
  gives the sizes and the chooser guesses OS blocks from `LDX #LO(...)`.

## PIPELINE

`symbols-src/pipeline.json` makes one set per program, from
[pipeline-disasm](https://github.com/mattgodbolt/pipeline-disasm):

- Each program runs on its own, with its own zero page, so a set per program keeps the game's `&70`
  (`cell_x`) apart from the Graphics Designer's (`sprite_width`) and the GRAPHIC stub's (`sectors_this_read`).
- A stub and the program it loads are often in memory together, but not always, so they're separate sets.
  The three stubs are one source assembled three times, told apart by their anchor at `read_whole_run`.
- WDATA, loaded by the Level Designer at its start and kept, is a region of the Level Designer's set. The
  other data files have no sets: IO, LEVEL1 and DEFAULT come in as their programs' globals, and the rest are
  pictures or `*EXEC` text.
- MENU and MISSION are BASIC, but each holds labelled machine code (MENU's scroller, MISSION's scrambler in
  a REM), so each has a set.

Where the regions are cut, and why:

- **The game.** The loader (H.GAME as loaded at `&3000`, which IO replaces, so `overwritten`) and the four
  pieces it copies, each where it runs. `main_code` is cut at `SWAP_START` and `SWAP_END`, which
  `load_mission` swaps into the screen while IO loads, and `game_start` is a region of its own: the level's
  objects are copied over it once it has run. `tableSizes` gives the four tables in zero page and the stack
  page that are written with an index; counted at 256 bytes their stores would leave `event_handler` nothing
  to anchor on.
- **The Level Designer.** `main`; `startup` (`entry` and the stored zero page, low code and font), which the
  level being edited fills; the low code and the font where `entry` moves them (the two `moves`); and WDATA.
  Its zero page section is `globalsSections`.
- **TITLE**: the file as loaded, which the picture unpacks over, and `unpack`, the part it moves to `&2F18`
  to run.
- **PL**: the decryptor, the encrypted bytes, and the cheat they decrypt to. The decryptor's last byte, a
  BMI opcode, is also the cheat's first instruction, so the decryptor is cut one byte early: otherwise both
  regions match there once PL has run, and the debugger would show neither.
- **MENU**: the BASIC program, the scroller and its message (C%), and the menu screen (S%), whose leftovers
  past its end are `avoid`ed.

The in-memory check's scenarios (`symbols-src/pipeline-check.js`) walk the menu, TITLE, the game (to its
loader, `game_start`, IO loading, the title screen and play, then seeded random play), the Level Designer,
the Graphics Designer and its tours of every menu, MRUN and PL.

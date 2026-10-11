# Symbol set importers

How the symbol sets under `public/symbols/sets/` are made from a title's source. The format is "Symbol
sets" in [the media registry proposal](media-registry-proposal.md); this is how a curator gets from a source
repository to a set in that format.

## The idea

A source repository never changes for jsbeeb, and needs no build rules for it. jsbeeb's tools take its source
at a commit and make what they read themselves: for a baron title, they run baron on each source with
`--symbols` and `-vv`; for a beebasm title, beebasm with `-v` and `-dd`; for a py8dis disassembly, they run
its control script under py8dis. Nobody has to emit jsbeeb metadata.

The curator's job lives here, beside the sets: which programs make a set, where a program's memory changes
while it runs (so where its regions are cut), and the anchors that tell the program apart in memory. Each
input format gets an importer, and every importer feeds one anchor chooser and the index's checks.

| Piece                                  | What it does                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tools/symbols/baron-build.js`         | Fetches a baron title's source at the config's commit and assembles it, each source on its own           |
| `tools/symbols/baron-listing.js`       | Reads one baron `-vv` listing: sections, statements and their bytes, labels, `=` names and scopes        |
| `tools/symbols/import-baron.js`        | The baron importer: names from the listings, cross-checked against the `--symbols` dump; writes the sets |
| `tools/symbols/beebasm-build.js`       | Fetches a beebasm title's source at the config's commit and assembles it, PRINTing its `=` names         |
| `tools/symbols/beebasm-listing.js`     | Reads beebasm's `-v` listing and its `-dd` label dump                                                    |
| `tools/symbols/import-beebasm.js`      | The beebasm importer: names from the listing, the dump and the saved files; writes the sets              |
| `tools/symbols/py8dis-dump.py`         | Runs a py8dis control script under py8dis and prints what py8dis made of the binary, as JSON             |
| `tools/symbols/import-py8dis.js`       | The py8dis importer: names and pieces from that dump; writes the sets                                    |
| `tools/symbols/title-build.js`         | Builds and imports a title with whichever importer its config names                                      |
| `tools/symbols/import-acornaeology.js` | The acornaeology importer: a ROM's set from its disassembly's JSON                                       |
| `tools/symbols/anchor-chooser.js`      | Chooses each region's anchors from what an importer read; shared by every importer                       |
| `tools/symbols/corpus-check.js`        | The corpus check a set's pull request carries                                                            |
| `tools/symbols/check-memory.js`        | Checks the sets against the title running in a headless jsbeeb, at moments the curator picks             |
| `tools/symbols/build-index.js`         | Checks every set as the registry's build will, and writes `index.json`                                   |
| `symbols-src/<title>.json`             | A curator's config for one title, or one ROM                                                             |
| `symbols-src/<title>-check.js`         | That title's moments for the in-memory check                                                             |

## A title's config

`symbols-src/<title>.json` names the title's sets and says where each is cut, in the source's own names.
Nothing in it is an address list: the names come from the build.

- `id`: the prefix of the title's set files, `<id>-<set id>.json`.
- `licence`, `notice`, `madeFrom`, and `home` if the author has a page of their own for the work: copied
  into every set.
- `source`: where the title's source is and what of it to assemble.
  - `assembler`: `baron`, unless it's `beebasm`; a beebasm title's config differs as
    [beebasm titles](#beebasm-titles) says.
  - `repository` and `commit`: the importer, the corpus check and the in-memory check fetch that commit, or
    take a checkout of it with nothing changed or added, and each set's `source` links the tree there. For
    a repository on GitHub, each set's `nameLink` links a name to the line that defines it at that commit.
  - `assemble`: globs, from the repository's root, of the sources to assemble. Every one, not only those
    that make a set: the anchors are chosen against everything the title puts in memory.
  - `defines`: symbols to predefine, name to a baron expression, passed as `-D name=expression`: what the
    title's own build passes, such as a build stamp the code prints, without which the source wouldn't
    rebuild the disc.
  - `disc`: the original disc in the repository, the one the source rebuilds. Its image key has to be one
    of `madeFrom`'s, and it's the disc the in-memory check boots.
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
    they copy. A label takes the store it's on, if it is, and if a loop in its section branches back to it,
    the loop's indexed stores up to the last branch back;
  - `globalsSections`: sections whose labels are the program's globals (zero page, say, which holds no code
    and which every program writes, so a region there couldn't be anchored).
- A region is a SECTION (`section`, in `source` if not the set's first), or part of one between `from` and
  `to`, expressions in the source's names (`pl.encrypted - 1`, `menu_screen + &700`). It can also have:
  - `overwritten`: run-once code that something else writes over when it's done, so only its own stores
    keep anchors off its bytes;
  - `avoid`: `[from, to)` ranges no anchor may cover, beyond what the chooser finds itself.

## Running it

For a baron title, with baron on the PATH, in `$BARON`, or given as `--baron`:

```sh
node tools/symbols/import-baron.js --config symbols-src/pipeline.json
node tools/symbols/build-index.js
node tools/symbols/corpus-check.js --config symbols-src/pipeline.json --corpus .registry-corpus/sth-disc
node tools/symbols/check-memory.js --config symbols-src/pipeline.json
```

Each fetches the config's commit into a temporary directory, or takes `--source`, a checkout of it, and runs
baron there on each source on its own, as `-D name=expression` for each of the config's `defines`, then
`-p <files> --inf --symbols <dump> -vv -log0 <listing>`. Plain `-v` cuts a statement's bytes at eight, so its
listing can't be read for them. The importer prints the baron it ran, from `--version`.

The importer, and so the corpus check, needs baron 0.5.0 or later, whose symbol dump replaced the flat one
an older baron wrote, and refuses the flat one. The in-memory check doesn't read the dumps, so any baron that
builds the source will do for it.

The importer writes nothing if a region can't be anchored, if its anchors all match another of the build's
images, if a set fails the index's checks, if the checkout isn't of the config's commit or has changes, or if
the config's disc isn't one `madeFrom` names. `--verbose` lists
every name left out, and why, and every anchor added to tell another image apart. The in-memory check takes
scenario names to run only those, and `--shots DIR` to save the screenshots a scenario asks for.

## beebasm titles

`import-beebasm.js` makes a beebasm title's sets, and its config differs from a baron title's:

- `source.assemble` is the one main source, and `source.directory` where beebasm runs (the repository's root
  if it names none), since beebasm finds an INCLUDE from where it runs, not from the file that INCLUDEs it.
- A region names a saved file, `file`, as its SAVE writes it (`"../build/CODE"`), instead of a section, and
  can be cut with `from` and `to` as a baron region can. beebasm has no sections: a SAVE writes whatever is
  in memory between two addresses.
- There's no `defines`, `stripScope`, `tableSizes`, `moves`, `globalsSections` or `leftToSystemSets` yet;
  nothing needed them. Nor does the importer write `nameLink` or `places` yet
  ([Links to the author](#links-to-the-author)).

```sh
node tools/symbols/import-beebasm.js --config symbols-src/nevryon.json
```

It takes `--source` as the baron importer does, and the beebasm to run as `--beebasm`, `$BEEBASM` or
`beebasm` on the PATH. It needs beebasm 1.11 or later, the [stardot/beebasm](https://github.com/stardot/beebasm)
release whose listing it was written against (the sets here were made with commit `ca2cc5f`); `-dd` came in
1.10, and Ubuntu's snap of 1.10 can't write under `/tmp`, where the build runs. The corpus check and
the in-memory check take `--beebasm` too.

The build copies the checkout, since a SAVE writes wherever its source says (making the directories it
needs), and runs beebasm on a wrapper that INCLUDEs the main source and then PRINTs each name the sources
assign with `=`: beebasm's dumps hold labels only. A name the wrapper can't PRINT, because it was assigned
inside braces or a loop, is dropped and the build run again.

What beebasm's output gives, and what the importer makes of it:

- **The listing** (`-v`) gives each instruction's address and bytes, with its operand already a number;
  each EQUB, EQUW and EQUD value; an EQUS's or INCBIN's address and first three bytes; a SKIP's address;
  each label's name, unscoped and without an address; and a line for each SAVE. SKIPTO, ALIGN and ORG leave
  no line.
- **The label dump** (`-dd -labels`) gives every label in the listing's order with its address and scopes:
  a label just before a `{` names it, and a scope with no label of its own, a FOR loop's pass or a macro's
  call is `_N` or `_var_value`. A label in a scope like that, one no dumped label is, is left out, as
  baron's `@` scopes are.
- **A saved file's address** isn't in any of it: the file starts at the address, among those listed before
  its SAVE, from which it agrees with every statement it covers and covers the most. Its statements are
  those in memory when it was saved, each the last listed at its address, so a block assembled over another
  after a CLEAR belongs to the files saved after it. Its bytes are the file's: a statement the listing cuts
  short runs to the next statement or label. Bytes no statement lists (SKIPTO and ALIGN padding) never
  anchor.
- **A label** goes to the file of the statement it's listed before, or, at the end of a block, of the one
  it's listed after, then to the region holding it there.
- **A `=` name** counts as an address when the sources write it first in a non-immediate operand
  (`LDA ptr`, `STA (vec),Y`), an instruction of the set's files names its value as a memory operand, the MOS
  set doesn't already name that address, no label of the set's regions is at it, and no other name that
  passes the same tests has the same value; names that share a value are all left out. It goes to the
  region it points into if only that region's code uses it, and to the globals otherwise. The listing's
  operands are numbers, so which name an instruction was written with is never known: `ptr` and `ptr2`,
  both `&70` and each used by different code, leave `&70` unnamed.
- **An OS block** is an `LDX #lo` beside an `LDY #hi` that make a label's address.
- **The original disc's files**, where its catalogue loads them, are among the images the anchors are chosen
  to tell apart, besides the saved files where they run.

What it gets wrong, or only roughly, beyond what the baron importer does:

- **Names shared by code that doesn't run together** (a sound driver's and a title screen's workspace at the
  same zero page address) are left out, where a baron title would keep each in its own region's code.
- **A `=` name written in an operand only through an expression's later term** (`LDA base + ptr`) or a
  macro's argument isn't seen as an operand, and the text search takes a name in a comment as readily as
  in code.
- **A label in braces that don't start at it** (`.routine LDA #0 : {`) loses its scope's name to `_N`, and
  every label inside is left out.
- **A file loaded in one place and run in another** is only compared with the corpus where it loads, so
  the corpus check never sees Nevryon's CODE, which loads at `&0E00` though `*LOAD CODE 1100` puts it at
  `&1100`.

## Names

- **Labels** go to the region of the section they're assembled in, qualified with their scopes
  (`select_sprite.down_not_0f`), less the set's `stripScope`. A label at a section's exclusive end
  (`main_code_end`) is in no region and is left out. A label inside an anonymous scope (baron's `@` names) is
  never used.
- **A virtual section's labels** (`SECTION zero_page, org=&00, virtual=TRUE`) are globals: the section only
  hands out addresses for workspace and keeps no bytes, so no region holds them. A program can include
  another's layout just to reckon offsets from it, so a label no instruction uses as a memory operand is
  kept only if some statement mentions it (`EQUW slot_28`, `LDA #LO(io_maps)`; not a `=` line, nor a string) and
  a statement reserving space (a SKIP, or an EQUW that keeps no bytes) starts at it; a label nothing reserves
  space at only marks where the workspace ends.
- **`=` names** count as addresses when an instruction uses them as a memory operand: the operand's first
  name, not after `#`, not a FUNCTION's result, and not one `leftToSystemSets` covers. Such a name goes to
  the region it points into if only that region's code uses it, and is a global otherwise.
- **One name per address.** In a region, a scope's own name wins over the labels inside it (`pl` over
  `pl.start`), then the label written last, nearest the bytes (`tune` over `sound_data`). In the globals,
  the `=` name or virtual section label the most instructions use as a memory operand; a label of a
  `globalsSections` section, or a virtual one only data mentions, counts as used by none.
- Every label the listing gives has to agree with the symbol dump, or the importer stops: the dump is what
  baron resolved, and the listing is where the scopes, sections and bytes come from.
- **Each name's place** is the file and line the symbol dump says defines it (`src/game.6502#L120`), in the
  set's `places`, for the `nameLink` a GitHub repository gets. For such a repository, a name in a set that
  the dump gives no place (any name, in a dump without lines) stops the import. A `defines` entry, like
  Scorched Earth's `BUILD`, has no listing line, so it's never a name in a set.

## Links to the author

Every importer should link each name back to its author's own site wherever there is one, with the set's
`home`, `nameLink` and `places` ("Symbol sets" in [the proposal](media-registry-proposal.md)), so that
someone reading a name in the debugger is one click from the author's own explanation of it:

- source on GitHub at a pinned commit: `places` from each name's file and line, and
  `https://github.com/<owner>/<repo>/blob/<commit>/{place}`;
- a disassembly published with an anchor per address, such as acornaeology's (`#addr-800E`): a `nameLink`
  with `{addr}`, and `home` for the disassembly's page;
- a plain text disassembly with no anchors, such as level7.org.uk's: a text fragment,
  `#:~:text={name}`, which takes a browser to the name's first appearance, and `home` for the page.

Where the author has no site of their own (a name list kept inside a tool, like py8dis's `acorn.py` for the
MOS), `source` is the link and the set has none of these.

The py8dis, beebasm and acornaeology importers don't write `home`, `nameLink` or `places` yet, so the names
of Repton 2, Nevryon, Daredevil Demis and BBC BASIC II have no links, though their sources are on GitHub
(and BASIC II's disassembly is on acornaeology's site).

## Anchors

Candidates are runs of 4 to 8 bytes of the region's own statements: whole instructions from an
instruction's start (aiming for 6 bytes), or data from any byte. A candidate is out if any of its bytes is:

- reached by a store whose target the instruction gives (an indexed store reaches 256 bytes, or all of zero
  page, unless `tableSizes` gives the table's size), except that a run-once region only minds its own
  stores, and the copies in `moves` don't count;
- in a block the code hands the OS (`LDX #LO(block)`), which OSWORD, OSFILE and OSGBPB write results into:
  from its label to the next one that starts code or another block, 18 bytes at most;
- SKIP or SKIPTO padding, or under a label the source names as dead or leftover (`unused`, `leftover`, `junk`,
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
- **The in-memory check** boots the title's disc (its repository's, or one its config fetches) and, at each
  moment a scenario picks, lists the regions whose anchors all match. A moment fails unless that's exactly
  the regions expected, and if two matching regions overlap, of one set or two, since the debugger then
  shows neither.

## What the baron importer gets wrong, or only roughly

- **One program's zero page used differently in different regions** loses names, since a set's globals hold
  one name per address: PIPELINE's game loader's `copy_return`, `copy_from` and `menu_keys` give way to the
  main code's `monster_x`, `monster_direction` and `work0`. So does baron's `ZA_AUTO` allocator, which gives
  routines that never run together the same zero page: Scorched Earth keeps one name for each such byte and
  loses the rest.
- **The operand rule misses** `=` names the code reaches only through an immediate's `LO()`/`HI()`, through
  a FUNCTION, or through a table of addresses, and takes a name whose instruction is dead code as readily as
  any. A virtual section's labels count any mention, so they aren't missed that way.
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
  ([baron#15](https://github.com/waitingforvsync/baron/issues/15)): baron 0.5.0's dump gives each label's
  section and how each symbol was defined (a label, an `=`, a `ZA_AUTO`), though not whether an `=` name is
  an address or a constant. The importer takes only values from it so far: a label's section from where the
  listing shows it, and an `=` name as an address only when an instruction uses it as one. Moving to the
  dump is for when baron#14 lets the importer stop reading the listing.
- **A table's size, and where the OS or a pointer writes**: nothing in the build says these, so the config
  gives the sizes and the chooser guesses OS blocks from `LDX #LO(...)`.

## py8dis disassemblies

A [py8dis](https://github.com/ZornsLemma/py8dis) disassembly is a control script that loads a binary, says
where pieces of it are `move()`d to run, and names addresses. `py8dis-dump.py` runs the script under py8dis
at the config's commit, lets py8dis trace and classify the binary as it would to emit assembly, and prints
what py8dis then holds instead of the assembly: each piece of the binary where it runs (the binary where it
loads, less what moves, and each move where it lands), every instruction and data line in it with its bytes,
and every name the script gave, with the move it was given in. So nothing reads py8dis's assembly back in,
and the output format the script was written for doesn't matter.

A py8dis title's config differs from a baron title's in these:

- `source.script`: the control script, from the repository's root. `source.directory`, if given, is where it
  runs, which is where the paths it loads its binary from start; else it runs in its own directory.
- `py8dis`: the `repository` and `commit` of the py8dis to run it under.
- `disc`: the disc the in-memory check boots, when the repository has none: the `url` of a zip, the `image`'s
  path in it, and its `key`, which the check refuses the image without.
- A region is `from` an address to `to` one (the end of the piece `from` is in, if not given), expressions
  in the script's names as a baron config's are. It has to lie in one piece.
- `moves` and `tableSizes` name their stores and tables by expressions too, since a script names few of the
  instructions it traces (`boot_relocate_0380_loop + 3`). A table is the store's operand exactly, so
  `STA table+1,X` is `table + 1`. A move can name a copy loop's first instruction, as a baron one names its
  label; the loop is the one in the piece with an instruction there, or in any piece if none or several have one.
- No `home`, `places` or `nameLink`: the importer writes no links yet ("Links to the author").

The importer runs it as

```sh
node tools/symbols/import-py8dis.js --config symbols-src/repton2.json
```

taking `--source` and `--py8dis`, clean checkouts of the two commits, instead of fetching them, and
`--python`, else `$PYTHON`, else `python3`. It runs Python with `-I` and `-B`, from a directory of its own,
so neither checkout's files are imported by accident or gain any. The corpus check and the in-memory check
take a py8dis title's config as they take a baron one's.

Its names:

- **A name** goes to the region holding its address in the piece of its move. One in a piece no region
  holds (a loader the disassembly added that the title doesn't have) is left out; one outside every piece
  is a global.
- **One name per address**: the first the script gave it, so a table's name (`data_tilegraphics_indices`)
  wins over its first entry's (`data_tile00_empty`) when the script names the table first.
- **One address per name**: a name the script gives two addresses stops the import, even if one of them is
  in no region, since a config expression using it couldn't say which it means.
- **Left out**: the names py8dis makes up (`l0070`, `sub_c1234`), expressions (`zp_ptr+1`), constants, and
  the names py8dis's `acorn.py` gives the OS and the hardware, which the system sets have.

And its anchors are the chooser's, with what py8dis can't say:

- Nothing marks the blocks code hands the OS, so no OS block keeps anchors off.
- Py8dis has no SKIP: every byte in a piece is the binary's.
- Every store is in the program, the disassembly's own loader included, unless `moves` says it's a copy.

Control scripts written for py8dis in September 2021 import `trace6502` and call
`acorn.add_standard_labels()`, which py8dis has since dropped and renamed; `py8dis-dump.py` puts them back,
as `commands.hook_subroutine` and `acorn.mos_labels`, so such a script runs unchanged under the config's py8dis (`2a60463` for Repton 2).

py8dis's own examples are disassemblies too, and the dump reads them: `examples/python/dfs226.py`,
`planb.py` and `lisp406.py` run from `examples/` (their `source.directory`). A set for one needs a config
like Repton 2's, its regions cut where its pieces run, and a disc or ROM to check it on. The importer can't
make DFS 2.26's yet: it moves two pieces to `&0D00`, and a region is found by its address alone.

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

## Scorched Earth

`symbols-src/scorched-earth.json` makes one set, the game, from
[beeb-scorched-earth](https://github.com/mattgodbolt/beeb-scorched-earth). INTRO, the BASIC that `!BOOT`
chains, has no names, so no set; the in-memory check makes sure nothing matches while it runs.

- The game prints its build stamp, which its Makefile passes as `-D BUILD=...`, so the config's `defines`
  gives the shipped disc's stamp. Without it the code after the stamp would move.
- SCORCH loads at `&1900` and copies the game down to `&0E00`, over where it was loaded, so the loader
  region is only its own code, from `loader`: as loaded, it would match beside the game it copied down,
  and the debugger would show neither.
- `startup` runs once from `skyrow` and `dirtrow`, which the first round fills. Before it calls the game it
  copies five tables into holes below `&0E00` (the bottom of the stack page, the cassette workspace, the
  printer buffer, the user-defined characters and the NMI area), each a region of its own. Its copy loops,
  and the loader's, are `moves`.
- `tableSizes` gives the per-player and per-shell arrays in the printer buffer, the user-defined characters
  and the NMI area, which would otherwise reach over the low tables beside them and the start of the code.
  `profile`'s is up to `fall_x`, since napalm's `liquid` is the same address and runs over three tables.
- The workspace sections are `globalsSections`, and `defs.6502`'s OS and hardware names are left to the
  MOS set.
- `avoid` keeps anchors off the talk lines, which are Wendell Hicken's, not the MIT licence's.

The scenarios (`symbols-src/scorched-earth-check.js`) walk INTRO and its instructions, the loader, the
start-up code and the setup screen, a human's turn and a computer's, and a two-round game of computers
through its explosions, scores, shop and champion.

## Repton 2

`symbols-src/repton2.json` makes one set from George Foot's
[repton2disassembly](https://github.com/gfoot/repton2disassembly), whose `repton2.bin` is the game's code
as it sits in memory once loaded, with a loader of his own appended.

- **Py8dis.** The repository doesn't say which py8dis made its `repton2.s`. Its scripts were committed on
  15 September 2021 (`42820e4`, `26137b7`); py8dis's xa output, which the Makefile assembles, starts the
  next day at `b75d139`, and `cf93419` on 19 September renamed `acorn.add_standard_labels()`. Every py8dis
  commit from `b75d139` to `c32b0f9`, the last before the rename, stops on the script's `byte()`s of
  addresses the binary doesn't load, so none remakes `repton2.s`. The config's py8dis, `2a60463`, runs it
  with the two names `py8dis-dump.py` puts back, and gives every name at the address `repton2.s` has it.
- **The regions** are where the game runs: `main` (`&0D00-&5FFF`, up to the screen), and the two
  pieces the loader moves, `music` to `&0380` and `page8` to `&0880`. The loader at `&70A0` is the
  disassembly's, not the game's, so it has no region; its copies to `&0380` and `&0880` are `moves`, or their
  indexed stores would leave the two pieces nothing to anchor on.
- **The disc** is Stairway to Hell's `Superior/Repton2.zip`, whose `D.REPB` is the game encrypted; once its
  loader has run, the three regions hold `repton2.bin`'s bytes exactly.

The in-memory check's scenarios (`symbols-src/repton2-check.js`) look at the loader, `start1`, the status
screen, play, the end of a game and the status screen again, then seeded random play.

## Nevryon

`symbols-src/nevryon.json` makes one set, `game`, from
[nevryon](https://github.com/waitingforvsync/nevryon)'s disassembly, from the four files its master source
saves: CODE, CODE2, CODE3 and GRAPHIX, each where the loader puts it. The repository's disc is Stairway to
Hell's `4thDimension/Nevryon.zip`, byte for byte.

- **GRAPHIX** starts 16 bytes in: CODE3 ends 16 bytes into it, and LOADER3 loads CODE3 after Loader2 has
  loaded GRAPHIX, so in memory those bytes are CODE3's.
- The loader's menu, which shows a picture over where GRAPHIX goes, matches nothing; the game's own title
  screen and play match all four.

The in-memory check's scenario (`symbols-src/nevryon-check.js`) goes through the intro, the options and the
menu, then into the game and seeded random play.

## Daredevil Demis

`symbols-src/daredevil-demis.json` makes one set, `game`, from
[daredevil-demis](https://github.com/mattgodbolt/daredevil-demis): one region over its one saved file, which
runs where it loads. The repository's disc, the one jsbeeb's GitHub disc list serves, is what the source
builds.

Its modules share zero page workspace (`strp`, `sfx_ptr` and `ttl_str` are all `&90`), so those addresses
go unnamed. The in-memory check's scenario (`symbols-src/daredevil-demis-check.js`) checks the title screen,
then seeded random play.

## acornaeology's ROMs

[acornaeology](https://github.com/acornaeology) publishes annotated disassemblies of Acorn's ROMs, each
version with a JSON file that dasmos writes beside the listing (schema 4): every statement with its bytes
and labels, and `external_labels`, the names it gives addresses outside the ROM. Its repositories for
NFS and ANFS and for ADFS publish schema 4 JSON with the same fields, so in principle
`tools/symbols/import-acornaeology.js` makes their sets too, each from a config like BASIC II's; only BASIC II
has one so far. Its Tube client runs in the second processor, which the debugger's sets don't read.

A config (`"importer": "acornaeology"`) has an `id`, which is also the set's file name, a `title`, the
`licence`, and:

- `source`: the `repository`, the `commit` to fetch, the `disassembly` JSON's path in it and the
  `licenceFile` whose text becomes the set's notice.
- `rom`: the ROM under `public/roms/` the set is anchored on. The importer refuses to write a set when
  the JSON's bytes aren't that ROM's.
- `regions`: each a `name`, a `start` and an `end`. A sideways ROM is cut at `&9000` and `&B000`, as the
  proposal says.
- `globals`: the ranges whose `external_labels` become the set's globals.
- `bytesPerAnchor`, `spreadAnchors`: as for baron.

```sh
node tools/symbols/import-acornaeology.js --config symbols-src/bbc-basic-2.json
node tools/symbols/build-index.js
```

Its names:

- **Every label of a statement** goes to the region that holds it. dasmos gives each address one label.
- **A name outside the ROM** is a global if it's in a `globals` range and no system set names its address:
  the MOS's names for its vectors and pointers stay the MOS's. Where two names share an address, the one
  the JSON's `memory_map` describes wins. The rest of `external_labels` (the hardware, the MOS's entry
  points) are left to the MOS's set.
- Constants and comments are never read.

Its anchors come from the same chooser, with every statement of the ROM as one section and no stores,
since nothing writes to a ROM. Every bank of every file under `public/roms/` that's a whole number of the
ROM's size is another image: a region gets another anchor where one of them would hold all its anchors,
and the importer fails if none tells them apart.

The set isn't `system`: BASIC's workspace names then name BASIC's own code's operands, and the memory view
while BASIC is paged in, but not another program's code. A game run from BASIC, with BASIC still paged in,
keeps its own names for the zero page it shares with BASIC's in its code; in the memory view, an address
the game's set and BASIC's both name, differently, shows neither, as the proposal's rule for two sets says.

`check-memory.js` boots a title's disc, so it doesn't check a ROM's set; `tests/unit/test-symbol-sets.js`
checks BASIC II's against the ROMs in `public/roms/`.

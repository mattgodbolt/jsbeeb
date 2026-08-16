# Teletext hardware tests

A DFS disc of MODE 7 test pages for settling questions about the SAA5050 that emulators disagree
about, or that nobody has measured. Each page is a still screen designed to be photographed; the
answers are read off the photograph afterwards.

Results from any machine are welcome, and results from _several_ machines are the point: a BBC B, a
B+, a Master and an Electron need not agree, and neither need two machines of the same model with
different chip revisions. If you run these, please record the model, the MOS version and the
markings on the character generator chip (IC14 on a Model B) alongside the photographs.

## Running it

SHIFT+BREAK boots to a menu. Press 1 to 6 for a page; any key returns to the menu.

Photograph the whole screen, including the title row, so a photograph identifies itself later.

The same disc runs under jsbeeb, so a photograph can be held against the emulator's own output:

    node tests/hardware/teletext/capture-refs.js

writes `refs/t1.png` to `refs/t6.png`, which are what jsbeeb draws for the identical pages.
Committed copies are already there.

## Reading a page

Every test row is a short label in columns 0 to 6 and a sequence of cells starting at column 8. The
ruler under the title numbers the cells from 0, so "cell 4" means screen column 12.

Test cells mostly use a mosaic that is a bar across the middle third of the cell. Adjacent cells
join into a continuous bar, so a cell that renders blank shows up as a **gap in the bar**, which is
much easier to judge on a photograph than a missing block in a field of solid white. Rows testing
separated graphics use a full block instead, where the point is the gaps within the cell.

## T1: hold graphics and the held character

The held character is the last mosaic seen; while Hold Graphics is on, a control code displays it
instead of a space. The question in every row is which cells still show the bar.

| Row | Sequence from cell 0                                  | Look at              | jsbeeb               |
| --- | ----------------------------------------------------- | -------------------- | -------------------- |
| REL | gfxWhite, bar, Hold, **Release**, Hold, Hold          | cells 4, 5           | **bar**              |
| COL | gfxWhite, bar, Hold, gfxYellow, Hold, Hold            | cell 3, then 4, 5    | white, then yellow   |
| SEP | gfxWhite, block, Hold, Separated, Hold, Hold          | cells 4, 5           | solid, not separated |
| CTL | gfxWhite, bar, gfxYellow, Hold, Hold                  | cells 3, 4           | gap                  |
| ALF | gfxWhite, bar, Hold, alphaWhite, gfxWhite, Hold, Hold | cell 3, then 5, 6    | bar, then gap        |
| CHR | gfxWhite, bar, "A", Hold, Hold                        | cells 3, 4           | bar                  |
| SPC | gfxWhite, bar, space, Hold, Hold                      | cells 3, 4           | gap                  |
| NHT | gfxWhite, bar, Hold, NormalHeight, Hold, Hold         | cells 4, 5           | bar                  |
| ROW | Hold to the end of the row, then Hold on the next     | next row, cells 1, 2 | gap                  |

**REL is the open question**, [#853](https://github.com/mattgodbolt/jsbeeb/issues/853). jsbeeb and
beebjit keep the held character across a Release; b-em, b2 and CLK clear it. A gap at cells 4 and 5
on hardware means jsbeeb is wrong.

**SEP is the second one worth the trip.** jsbeeb re-shows the held character with the mosaic style
that was current when it was _held_, so a later Separated code does not separate it. Whether the
real chip re-renders it separated has not been surveyed across emulators.

CTL, CHR and SPC are the rules jsbeeb relies on elsewhere: a control code outside hold graphics
clears the held character, an alphanumeric seen in graphics mode does not become the held character,
and a space does, because in graphics mode a space is a blank mosaic. ROW and NHT are controls that
every emulator agrees on; if they disagree on hardware, suspect the rig before the chip.

## T2: set-at or set-after, seen through hold graphics

A control code's own cell is normally blank, so whether a code takes effect at its own cell (set-at)
or the next one (set-after) is invisible. Under hold graphics that cell shows the held character
instead, which makes the difference visible. Background codes are the exception: a blank cell still
has a background, so T4 tests those in plain alphanumerics too.

| Row  | Look at                       | jsbeeb                      | Meaning                                                                     |
| ---- | ----------------------------- | --------------------------- | --------------------------------------------------------------------------- |
| STDY | cell 5, the Steady code       | steady                      | Steady is set-at ([#611](https://github.com/mattgodbolt/jsbeeb/issues/611)) |
| FLSH | cell 4, the Flash code        | steady                      | Flash is set-after                                                          |
| CNCL | cell 4, the Conceal code      | gap                         | Conceal is set-at                                                           |
| HOLD | cell 2, the Hold code         | bar                         | Hold is set-at                                                              |
| NEWB | where yellow starts           | cell 4, the code's own cell | New Background is set-at                                                    |
| BLKB | where black returns           | cell 6, the code's own cell | Black Background is set-at                                                  |
| DBLH | cell 4, the DoubleHeight code | gap                         | a size change clears the held character                                     |

STDY and FLSH alternate with the flash phase, so take two photographs a second apart, or one of
each phase.

## T3: double height

Each test is a pair of adjacent rows. The lower row of a pair shows the bottom halves of the row
above; the label in columns 0 to 6 of a lower row is _normal_ height, so what happens to it is
itself the test.

| Rows             | Test                                            | jsbeeb                                                                                       |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| PAIR, LOW1       | both rows carry the double height code          | top halves, then bottom halves; the LOW1 label is blanked                                    |
| ONLY, LOW2       | only the upper row carries it                   | LOW2's own text is blanked and the bottom halves show instead                                |
| MID, MID2        | the code appears mid-row                        | cells before it stay normal height                                                           |
| BACK, BAK2       | double height, then NormalHeight mid-row        | the tail returns to normal height                                                            |
| TRI1, TRI2, TRI3 | three consecutive double height rows            | TRI1/TRI2 pair up, TRI3 starts a fresh pair, so its bottom half lands on the blank row below |
| HELD             | gfxWhite, block, Hold, DoubleHeight, Hold, Hold | block at cell 1, gap at 4 to 6                                                               |

Whole rows appearing to be missing is expected: jsbeeb blanks normal-height cells on the lower row
of a pair, which is why the LOW1 and TRI2 labels are not drawn. If those labels are legible on
hardware, that is a real difference and the most likely thing on this page to be wrong.

## T4: black codes, conceal, backgrounds

| Row  | Question                                 | jsbeeb                                   |
| ---- | ---------------------------------------- | ---------------------------------------- |
| ABLK | is alpha black (code 0) implemented?     | no: "CD" stays white                     |
| GBLK | is graphics black (code 16) implemented? | no: the bars stay white                  |
| CNCL | conceal (code 24)                        | "HIDDEN" is invisible                    |
| CNCO | does a later colour code cancel conceal? | yes: "BACK?" reappears in green          |
| CNGF | conceal in graphics mode                 | the bars after it are invisible          |
| NEWB | where does the new background start?     | at the code's own cell (set-at)          |
| BLKB | where does black background start?       | at the code's own cell (set-at)          |
| BOX  | start box (11) and end box (10)          | no visible effect; they render as spaces |

The two black codes are the interesting ones. jsbeeb ignores both, which is right for a chip that
does not implement them and wrong for one that does, and the SAA5050 family is not consistent about
it across variants.

## T5: character set

The whole set in alphanumerics, contiguous mosaics and separated mosaics, plus row `G@`, which is
&40 to &5F seen in graphics mode (alphanumerics, not mosaics), and two rows of double height text
chosen for diagonals and descenders, where the chip's rounding shows.

Nothing here is a disagreement to settle, and no issue is open on it. It is a reference photograph
of the real font to compare our glyph data and our rounding against, for whenever one is.

## T6: flash timing

A band of flashing blocks above a band of steady ones, for a high speed camera. Count the fields the
top band is missing against the fields it is present.

|         | cycle     | blanked  |
| ------- | --------- | -------- |
| jsbeeb  | 64 fields | 16 (3:1) |
| b2      | 64 fields | 16 (3:1) |
| beebjit | 48 fields | 16 (2:1) |

Two independent implementations agreeing on 64/16 is weak evidence, not a measurement; see the flash
section of [#766](https://github.com/mattgodbolt/jsbeeb/issues/766).

## Building the disc

    beebasm -i build.asm -do teletext-tests.ssd -title "TTTESTS" -opt 3

Sources are plain text BASIC in `src/`, tokenised by beebasm's `PUTBASIC`. `!BOOT` chains `MENU`.

Two things to know before editing a page:

- `TAB(n)` inside a `PRINT` compares against BASIC's `COUNT`, and `TAB(x,y)` (VDU 31) does not reset
  `COUNT`. After a long line, `TAB(8)` sees a count past 8 and issues a newline instead, which puts
  a row's cells one row below its label. Use the two-argument `TAB(x,y)`, which is what `PROCrow`
  does.
- In graphics mode a space is a blank mosaic and becomes the held character, so a test sequence
  cannot be padded with spaces. End the row instead.

## Not covered here

The teletext questions that need machine code and a reprogrammed CRTC rather than a MODE 7 page:
mid-character changes of the teletext select bit
([#766](https://github.com/mattgodbolt/jsbeeb/issues/766)), and teletext fed while in a bitmapped
mode ([#832](https://github.com/mattgodbolt/jsbeeb/issues/832)). beebjit carries a test image for
the latter at `test/display/teletext_bytes_pipeline.ssd`.

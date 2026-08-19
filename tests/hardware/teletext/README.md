# Teletext hardware tests

A DFS disc of MODE 7 test pages for settling questions about the SAA5050 that emulators disagree
about, or that nobody has measured. Each page is a still screen designed to be photographed; the
answers are read off the photograph afterwards.

## Results so far

Measured on **one BBC Master 128, MOS 3.20**, on 16 August 2026, photographed from an LCD.

Everything measured agreed with jsbeeb, on all six pages. Two questions that were open before are
answered:

- **Release Graphics does not clear the held character.** jsbeeb and beebjit were right; b-em, b2
  and CLK clear it and are wrong. Resolves the question in
  [#853](https://github.com/mattgodbolt/jsbeeb/issues/853).
- **The flash cycle is 64 fields with 16 blanked**, a 3:1 ratio. jsbeeb and b2 use those numbers;
  beebjit's 48-field cycle does not match. See the flash section of
  [#766](https://github.com/mattgodbolt/jsbeeb/issues/766).

Two caveats worth keeping in mind before treating any of this as settled for every machine:

- **It is one machine and one chip.** A B, a B+, an Electron or another Master could differ, and
  nobody has measured one. The emulators that disagree do so at the chip level, with no
  machine-model branch anywhere in their teletext code, so the disagreement is about what the
  SAA5050 does rather than about which machine it sits in. That makes a Master measurement relevant
  to all of them, but it does not make it universal.
- **T5 was compared by eye**, not by pixel. The glyphs and the rounding look right against
  `refs/t5.png`, which is not the same as having diffed them.

Results from other machines are wanted. If you run these, please record the model, the MOS version
and the markings on the character generator chip (IC14 on a Model B) with the photographs.

## Running it

SHIFT+BREAK boots to a menu. Press 1 to 8 for a page; any key returns to the menu.

The same disc runs under jsbeeb, so a photograph can be held against the emulator's own output:

    node tests/hardware/teletext/capture-refs.js

writes `t1.png` to `t8.png` into the `refs` directory beside the script, whatever directory you run
it from. Committed copies are already there.

## Photographing a page

Every page carries a white rule across rows 1 and 24, from column 1 to column 38. They are there to
be measured, not read: the two rules give four known points, which is enough to correct for the
camera being off square before reading anything else off the picture. Get both of them in the frame.

This matters more than it sounds. A photograph about a degree off square drags a row sideways by
more than its own height across a 40 column screen, so a row's label ends up on one scanline and its
cells on another, and anything that finds rows by scanning across the picture reads the wrong row.
Being square-on beats being close-up: shoot from the centre of the screen, use the phone's levelling
grid, and fill the frame with the screen. Reflections in the panel are a nuisance but not fatal, as
long as they miss the rules and the cells being measured.

For T6, film rather than photograph, at a known high frame rate, and record what that rate was.

## Reading a page

Every test row is a short label in columns 0 to 6 and a sequence of cells starting at column 8. The
ruler under the title numbers the cells from 0, so "cell 4" means screen column 12.

Test cells mostly use a mosaic that is a bar across the middle third of the cell. Adjacent cells
join into a continuous bar, so a cell that renders blank shows up as a **gap in the bar**, which is
much easier to judge on a photograph than a missing block in a field of solid white. Rows testing
separated graphics use a full block instead, where the point is the gaps within the cell.

Where a row's own measurement is in doubt, compare it against a row on the same page whose extent
is not in dispute: T1 `NHT` and T2 `HOLD` are there partly for that, and calibrating from one of
them needs no ruler at all.

## T1: hold graphics and the held character

The held character is the last mosaic seen; while Hold Graphics is on, a control code displays it
instead of a space. The question in every row is which cells still show the bar.

| Row | Sequence from cell 0                                  | Look at              | jsbeeb               | Master  |
| --- | ----------------------------------------------------- | -------------------- | -------------------- | ------- |
| REL | gfxWhite, bar, Hold, **Release**, Hold, Hold          | cells 4, 5           | **bar**              | **bar** |
| COL | gfxWhite, bar, Hold, gfxYellow, Hold, Hold            | cell 3, then 4, 5    | white, then yellow   | agrees  |
| SEP | gfxWhite, block, Hold, Separated, Hold, Hold          | cells 4, 5           | solid, not separated | agrees  |
| CTL | gfxWhite, bar, gfxYellow, Hold, Hold                  | cells 3, 4           | gap                  | agrees  |
| ALF | gfxWhite, bar, Hold, alphaWhite, gfxWhite, Hold, Hold | cell 3, then 5, 6    | bar, then gap        | agrees  |
| CHR | gfxWhite, bar, "A", Hold, Hold                        | cells 3, 4           | bar                  | agrees  |
| SPC | gfxWhite, bar, space, Hold, Hold                      | cells 3, 4           | gap                  | agrees  |
| NHT | gfxWhite, bar, Hold, NormalHeight, Hold, Hold         | cells 4, 5           | bar                  | agrees  |
| ROW | Hold to the end of the row, then Hold on the next     | next row, cells 1, 2 | gap                  | agrees  |

**REL was the open question**, and the easiest way to read it is to compare the length of the `REL`
bar against `NHT` five rows down, which every emulator agrees keeps the held character. On the
Master they are the same length, and `CTL` and `SPC` are the contrast: those stop after cell 1.

**SEP was a second question** nobody had surveyed. jsbeeb re-shows the held character with the
mosaic style that was current when it was _held_, so a later Separated code does not separate it.
The Master shows no separation gaps in cells 4 and 5 either.

## T2: set-at or set-after, seen through hold graphics

A control code's own cell is normally blank, so whether a code takes effect at its own cell (set-at)
or the next one (set-after) is invisible. Under hold graphics that cell shows the held character
instead, which makes the difference visible. Background codes are the exception: a blank cell still
has a background, so T4 tests those in plain alphanumerics too.

| Row  | Look at                       | jsbeeb                      | Master | Meaning                                                                     |
| ---- | ----------------------------- | --------------------------- | ------ | --------------------------------------------------------------------------- |
| STDY | cell 5, the Steady code       | steady                      | agrees | Steady is set-at ([#611](https://github.com/mattgodbolt/jsbeeb/issues/611)) |
| FLSH | cell 4, the Flash code        | steady                      | agrees | Flash is set-after                                                          |
| CNCL | cell 4, the Conceal code      | gap                         | agrees | Conceal is set-at                                                           |
| HOLD | cell 2, the Hold code         | bar                         | agrees | Hold is set-at                                                              |
| NEWB | where yellow starts           | cell 4, the code's own cell | agrees | New Background is set-at                                                    |
| BLKB | where black returns           | cell 6, the code's own cell | agrees | Black Background is set-at                                                  |
| DBLH | cell 4, the DoubleHeight code | gap                         | agrees | a size change clears the held character                                     |

STDY and FLSH alternate with the flash phase, so photograph both phases. In the blanked phase STDY
lights from cell 5 rightwards with 1 to 4 dark, and FLSH lights cells 1 to 4 with 5 and 6 dark.

## T3: double height

Each test is a pair of adjacent rows. The lower row of a pair shows the bottom halves of the row
above; the label in columns 0 to 6 of a lower row is _normal_ height, so what happens to it is
itself the test.

| Rows             | Test                                            | jsbeeb                                                        | Master |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- | ------ |
| PAIR, LOW1       | both rows carry the double height code          | top halves, then bottom halves; the LOW1 label is blanked     | agrees |
| ONLY, LOW2       | only the upper row carries it                   | LOW2's own text is blanked and the bottom halves show instead | agrees |
| MID, MID2        | the code appears mid-row                        | cells before it stay normal height                            | agrees |
| BACK, BAK2       | double height, then NormalHeight mid-row        | the tail returns to normal height                             | agrees |
| TRI1, TRI2, TRI3 | three consecutive double height rows            | TRI1/TRI2 pair up, TRI3 starts a fresh pair                   | agrees |
| HELD             | gfxWhite, block, Hold, DoubleHeight, Hold, Hold | block at cell 1, gap after                                    | agrees |

Whole rows appearing to be missing is correct, not a fault: normal-height cells on the lower row of
a pair are blanked, on the Master as in jsbeeb, which is why the LOW1, LOW2, MID2, BAK2 and TRI2
labels are not drawn. The quickest check on this page is which labels are absent.

## T4: black codes, conceal, backgrounds

| Row  | Question                                 | jsbeeb                                   | Master |
| ---- | ---------------------------------------- | ---------------------------------------- | ------ |
| ABLK | is alpha black (code 0) implemented?     | no: "CD" stays white                     | agrees |
| GBLK | is graphics black (code 16) implemented? | no: the bars stay white                  | agrees |
| CNCL | conceal (code 24)                        | "HIDDEN" is invisible                    | agrees |
| CNCO | does a later colour code cancel conceal? | yes: "BACK?" reappears in green          | agrees |
| CNGF | conceal in graphics mode                 | the bars after it are invisible          | agrees |
| NEWB | where does the new background start?     | at the code's own cell (set-at)          | agrees |
| BLKB | where does black background start?       | at the code's own cell (set-at)          | agrees |
| BOX  | start box (11) and end box (10)          | no visible effect; they render as spaces | agrees |

The two black codes were the interesting ones, because ignoring them is right for a chip that does
not implement them and wrong for one that does. This Master's chip does not implement either.

BLKB is easiest to read from the gap: there is exactly one black cell between the end of the yellow
and the "CD", which is the code's own cell having already gone black.

## T5: character set

The whole set in alphanumerics, contiguous mosaics and separated mosaics, plus row `G@`, which is
&40 to &5F seen in graphics mode (alphanumerics, not mosaics), and two rows of double height text
chosen for diagonals and descenders, where the chip's rounding shows.

Nothing here is a disagreement to settle, and no issue is open on it. It is a reference photograph
of the real font to compare our glyph data and our rounding against, for whenever one is.

## T6: flash timing

A band of flashing blocks above a band of steady ones. Film it at a known high frame rate and count
the fields the top band is missing against the fields it is present. The steady band below is the
control: if it flickers too, the camera or the display is doing it rather than the SAA5050.

Measured on the Master from a 120 fps video, which is 2.4 video frames per 50 Hz field:

|            | video frames   | fields       |
| ---------- | -------------- | ------------ |
| blanked    | 39, 37, 38, 38 | 15.4 to 16.2 |
| shown      | 116, 116, 116  | 48.3         |
| full cycle | 154            | 64.2         |

So 16 blanked of every 64. The steady band stayed lit in all 662 frames.

|         | cycle     | blanked  |          |
| ------- | --------- | -------- | -------- |
| Master  | 64 fields | 16 (3:1) | measured |
| jsbeeb  | 64 fields | 16 (3:1) | agrees   |
| b2      | 64 fields | 16 (3:1) | agrees   |
| beebjit | 48 fields | 16 (2:1) | does not |

## T7: row edges

Bars that run to the right hand edge of the row, held and unheld, and rows that end in spaces, to
see where the held character stops and whether anything leaks into the next row. The ruler on row 2
numbers columns 30 to 39. Not yet measured on hardware.

## T8: the ULA switches at 2MHz, even in a 1MHz mode

Not a MODE 7 page. It is MODE 4, a 1MHz mode, with the screen start moved to &2800 so that MA13 is
set and the SAA5050 is fed the same bytes the bitmap is showing. The bytes are &FF, which the bitmap
shows as solid red (logical colour 1) and the SAA5050 shows as its solid block. A cycle counted
raster loop then flips the ULA's teletext select bit six times on each of 128 scanlines, 11 cycles
apart: **5.5 character cells**. Alternate flips therefore land on a cell boundary and half way
through a cell.

So the picture is a red field with three white boxes across it, the boxes and the gaps between them
all 5.5 cells wide, and the ruler rows of one cell ticks above and below it, with a half width tick
every eight cells, are there to measure them against.

What to look for is whether the boxes and gaps are **equal**, or alternate between 5 and 6 cells.
Equal means the ULA switches its output at 2MHz regardless of the character clock, so a write half
way through a cell changes the second half of that cell. Alternating means it only switches on cell
boundaries.

|          | boxes            |                                                                  |
| -------- | ---------------- | ---------------------------------------------------------------- |
| hardware | equal, 5.5 cells | the ULA's output stage runs at 2MHz whatever the character clock |
| jsbeeb   | equal, 5.5 cells | since the fix below; 5 and 6 alternating before it               |

The hardware line is what the people who measure these things on real machines say the ULA does,
and what b2 already rendered; it is not yet a photograph of this page. The test program that showed
jsbeeb and beebjit rounding every flip out to a cell boundary had the same structure as this page,
which is the publishable version of it. The fix in jsbeeb is in `video.js`: a ULA register write
landing between the two 2MHz ticks of a 1MHz cell repaints the second half of the cell. See
[#766](https://github.com/mattgodbolt/jsbeeb/issues/766).

Two things about running it on hardware:

- The loop is locked to the raster once it starts, but where the boxes sit horizontally depends on
  when the program happened to catch vsync, to within about four cells. Only the widths matter.
- The CPU's 1MHz bus and the video clock can come up in either of two phases at power on, half a
  cell apart ([#876](https://github.com/mattgodbolt/jsbeeb/issues/876)). That swaps which flips
  land on a boundary and which on a half cell, so the boxes may start on a boundary on one power
  cycle and on a half cell on the next. They should be 5.5 cells wide either way.

The program writes its CRTC registers directly rather than through `VDU 23`, because MOS 3.20 folds
the `*TV` interlace setting into R8 writes made that way and the loop needs R8 at zero to know the
frame is exactly 312 lines.

## Building the disc

    beebasm -i build.asm -do teletext-tests.ssd -title "TTTESTS" -opt 3

Sources are plain text BASIC in `src/`, tokenised by beebasm's `PUTBASIC`. `!BOOT` chains `MENU`.

Four things to know before editing a page:

- `TAB(n)` inside a `PRINT` compares against BASIC's `COUNT`, and `TAB(x,y)` (VDU 31) does not reset
  `COUNT`. After a long line, `TAB(8)` sees a count past 8 and issues a newline instead, which puts
  a row's cells one row below its label. Use the two-argument `TAB(x,y)`, which is what `PROCrow`
  does.
- In graphics mode a space is a blank mosaic and becomes the held character, so a test sequence
  cannot be padded with spaces. End the row instead.
- Rows 1 and 24 belong to the alignment rules, and the rules stop at column 38 because printing in
  the last column of the last row scrolls the screen.
- A `\` comment in BASIC's inline assembler ends at a colon as well as at the end of the line, and
  what follows the colon is assembled. Keep colons out of assembler comments.

## Not covered here

Teletext fed while in a bitmapped mode, and the relative timing of the two pipelines
([#832](https://github.com/mattgodbolt/jsbeeb/issues/832),
[#876](https://github.com/mattgodbolt/jsbeeb/issues/876)). beebjit carries a test image for this at
`test/display/teletext_bytes_pipeline.ssd`.

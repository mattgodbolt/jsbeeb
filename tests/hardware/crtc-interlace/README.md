# Interlace sync and CRTC frame restarts

A DFS disc that measures what the 6845 does with interlace sync (R8 bit 0) when a TV field is made of
several CRTC frames, as in vertical rupture. Emulators disagree about it, and nobody has measured it.

## The question

With interlace sync on, the 6845 makes alternate fields half a line longer: on the even field the vsync
starts and ends half a line late, and one extra "dummy" raster follows the end of a frame. When a field
holds only one CRTC frame there is no doubt which frame gets it. When a field is a chain of short frames,
each restarted by an R4/R9 hit, which of them gets the extra raster?

- **jsbeeb** gives it only to a frame that saw an R6 or R7 hit. That rule came from hardware testing
  against Kieran's MODE 7/75 in [#294](https://github.com/mattgodbolt/jsbeeb/pull/294); b2 took its CRTC
  from jsbeeb and has the same rule. A chain then gets one extra raster per pair of fields, whatever its
  length.
- **beebjit** gives one to every frame that ends on the even field, so a chain of N extra frames grows
  the even field by N lines. BeebEm's scanline model appears to do the equivalent, from a reading of its
  `Video.cpp` (it has not been run against this disc): it lengthens the first scanline after every frame
  restart on alternate fields.

## The test

Each field is N short CRTC frames (R4 = 3, R9 = 7, so 32 lines each) followed by one frame that holds R6
and R7 and the vsync, sized so that the field is 312 lines. The CPU only ever rewrites R4, each time
about a character row into a window four rows wide, so nothing depends on write timing to the character.
User VIA timer 2 runs freely and the program timestamps every vsync (system VIA CA1) with it, discarding
the first eight fields of each configuration.

It runs R8 = 0 and R8 = 1 against N = 0, 1, 2 and 4, and against two placements of R6 in the short
frames: R4 + 1 ("gap 1") and R4 + 2 ("gap 2"). Gap 1 matters because beebjit counts the dummy raster as
row R4 + 1, and so with gap 1 the dummy raster makes an R6 hit, which beebjit also uses to count fields.

The table it shows at the end gives, for each configuration, the mean length of each of the two
alternating fields in microseconds and the pair of them in 64 us lines. One sample is up to about 8 us
late because of the polling loop, so the averages carry a microsecond or two of noise.

## Results so far

Lines per pair of fields. N is the number of short frames per field.

| R8  | N         | gap | jsbeeb, B and Master | beebjit 6d51e24, B and Master    | Hardware |
| --- | --------- | --- | -------------------- | -------------------------------- | -------- |
| 0   | any       | any | 624                  | 624                              |          |
| 1   | 0         | any | 625                  | 625                              |          |
| 1   | 1 / 2 / 4 | 2   | 625                  | 626 / 627 / 629                  |          |
| 1   | 1 / 2 / 4 | 1   | 625                  | 628 for each N (314 every field) |          |

Nothing has been run on hardware yet. If you run it, please record the model, the MOS version and the
markings on the 6845, and send a photograph of the table.

## Running it

SHIFT+BREAK boots it. It runs for about 15 seconds with the screen mostly blank, then shows the table in
MODE 7.

Under jsbeeb, the same table is printed with:

    node tests/hardware/crtc-interlace/run.js            # Model B
    node tests/hardware/crtc-interlace/run.js Master

Under beebjit, save the MODE 7 screen when the program writes its finishing marker to &FCD0, then decode
it:

    ./beebjit -0 interlace-restarts.ssd -headless -fast -accurate -debug -autoboot \
        -commands "b expr 'addr==0xfcd0 && is_write' commands 'savemem screen.bin 7c00 400;q';c"
    node tests/hardware/crtc-interlace/run.js --screen screen.bin

Add `-master` for the Master.

## Building it

The source is for [Baron](https://github.com/waitingforvsync/baron):

    baron -o interlace-restarts.ssd --opt 3 --title ILACE interlace-restarts.6502

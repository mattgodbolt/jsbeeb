# The audio path, and what a real Master 128 measures

**Status:** working notes for issue #921. The outputs below are what ships, fitted to a first set
of measurements from one Master 128; the open questions are at the end.

## What jsbeeb models

`SoundChip` (`src/soundchip.js`) renders the SN76489 at 500 kHz (the 4 MHz chip clock over 8) with a
first-order DC blocker whose corner comes from the board's peak detector (10K into 4µ7, issue #863).
The worklet (`src/web/audio-renderer.js`) then runs, at the chip rate, the stages for the chosen
output, and a `PolyphaseResampler` (`src/resampler.js`, a windowed sinc cut off at 0.4 of the output
rate so the sample-playback carriers at 31 kHz and above fold nowhere, #919).

The outputs, chosen in the configuration dialog or with `audioOutput=` in the URL, are defined in
`src/audio-output.js` and shared with `tools/audio-sweep.js` so a headless run replays the same path:

- **board**: the board's output stage as measured at the speaker terminals. The Sallen-Key low-pass
  (7234 Hz, Q 0.696; `audiofilterfreq` and `audiofilterq` override it, and `audiofilterfreq=0` turns
  the whole path off) and three first-order high-passes from the coupling capacitors: C10 100nF into
  the LM386's 50K (32 Hz), C79 330nF into 4K7 + 1K (85 Hz), and C18 47µF into the 8 Ω speaker
  (423 Hz).
- **speaker**, the default: the board stages and then the internal speaker and case, fitted to the
  microphone measurements below as five biquads (a second-order high-pass at 550 Hz, Q 1.56; a
  peak of +16.5 dB at 460 Hz, Q 3.5; a peak of +13.9 dB at 2750 Hz, Q 0.5; a high shelf of
  -16.7 dB from 5600 Hz, Q 1.3; a low-pass at 11.7 kHz, Q 1.7), then scaled so the chain peaks at
  unity, which leaves it about 10 dB quieter than the board output at 1 kHz. Replayed headlessly
  and compared with the four microphone takes, it is within 3 dB at every step from 173 Hz to
  7.8 kHz except the three interference dips on which the takes disagree among themselves.
- **off**: the resampled chip output alone.

## The Master 128 output stage

From Acorn drawing 0143,000/C "Master 128 Main PCB Circuit Diagram" sheet 2, in
[Acorn_MasterTechnicalDrawings.zip](https://chrisacorns.computinghistory.org.uk/docs/Acorn/Manuals/Acorn_MasterTechnicalDrawings.zip),
cross-checked against the parts list in the
[Master Series Service Manual](https://chrisacorns.computinghistory.org.uk/docs/Acorn/Manuals/Acorn_MasterSM.pdf).
The manual refers to an "Audio Circuitry" section that does not exist, so the drawing is the
only description. The widely circulated redrawn schematic (stardot thread 22660) labels C10 as
100pF and misnames the Zobel resistor; read values off the Acorn scan.

| Stage                  | Parts                                                                                                         | Effect                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Mixer                  | R30 100K into a virtual-earth LM324 stage, R39 39K feedback; peak detector D7, C14 4µ7, R32 10K into R35 220K | gain 0.39; the 2:1 envelope injection                                         |
| Coupling (Master only) | D23 level shift, C79 330nF into R26 4K7 / R13 1K                                                              | first-order high-pass, 85 Hz                                                  |
| Sallen-Key             | R20 10K, R28 10K, C9 2n2, C12 2n2, gain 1 + 22K/39K                                                           | f0 7234 Hz, Q 0.696, gain 1.56: the same as the Model B, and what jsbeeb runs |
| Into the LM386         | C10 100nF into about 50K                                                                                      | high-pass, 32 Hz                                                              |
| LM386                  | pins 1 and 8 open                                                                                             | gain 20                                                                       |
| Into the speaker       | C18 47µF                                                                                                      | high-pass, 423 Hz at 8 Ω, 212 Hz at 16 Ω                                      |
| Zobel                  | R38 10R, C16 47nF                                                                                             | far above audio                                                               |

There is no volume control on a Master 128 (the Model B's VR1 does not exist), so captures
are repeatable without a pot to worry about. The 128's speaker impedance is not in any Acorn
document; the B+ manual says 8 Ω, the Compact's parts list says 16R.

So above 500 Hz the shipped model is the right one for a Master, and the two high-passes
below it (C79 and C18) are a straight addition to the defaults once a line-level capture
confirms them.

## The sweep tool

`tools/audio-sweep.js` (run from the repository root):

- `build [sweep.ssd]` writes a test disc. The program pokes the chip's registers directly
  with interrupts off, so each step's frequency is exact, 4 MHz / (32 N). The sequence is 62 s:
  a marker, 32 tones a quarter octave apart from 122 Hz to 25 kHz at full volume, every other
  one again at -8 and -16 dB, a 16-step volume staircase at 1250 Hz, the eight noise modes,
  the four sample-playback carriers with a slow volume ramp, and a closing marker. The event
  count ticks up on screen and it prints "Done".
- `reference out.wav [--model Master] [--rate 48000] [--output speaker|board|off]` boots the disc headlessly
  through the real `SoundChip`, board filter and resampler and writes what jsbeeb would play.
- `analyse a.wav [b.wav]` aligns each capture on its markers, measures the rate difference
  between the machine's clock and the recorder's from the marker spacing, and prints per step the
  fundamental in dBFS, the second and third harmonics, the staircase, noise band levels and
  the carrier segments. With two files, `rel` is b relative to a with each normalised to its
  977 Hz full-volume tone, so recorder gain drops out.

To capture: start the recorder, SHIFT+BREAK the disc, wait for "Done". Then
`reference ref.wav` and `analyse ref.wav capture.wav`. The `rel` column is everything jsbeeb
does not model, in one ratio.

## Measurements, 2026-08-29: microphone at the speaker

Four takes on a Master 128 through its internal speaker, microphone a few centimetres from
the grille under a blanket, 16-bit mono 44.1 kHz. (The recordings are not in the repository.)
The machine's clock and the recorder's ran at rates 430 to 460 ppm apart on every
take. Noise in the gaps between tones was around -60 dBFS broadband and -70 to -110 dBFS
within a tone's bin; every step from 200 Hz to 18 kHz had 25 to 68 dB of signal above it.
The -8 and -16 dB sweeps agreed with the full-volume one within a dB or two wherever there was
signal, so the path is linear at these levels. `*CONFIGURE LOUD` versus `QUIET` made no
difference, as expected: it only sets the boot beep.

Relative to jsbeeb's output for the same disc, normalised at 977 Hz. Mean of the four takes
and the spread between them, in dB. This includes the microphone's own response, which is
unknown.

|    N |    Hz | mean | spread |                    |
| ---: | ----: | ---: | -----: | ------------------ |
| 1023 |   122 |  -44 |     12 | at the noise floor |
|  860 |   145 |  -41 |     15 | at the noise floor |
|  723 |   173 |  -36 |      7 |                    |
|  608 |   206 |  -33 |      7 |                    |
|  512 |   244 |  -23 |      5 |                    |
|  430 |   291 |  -27 |      9 |                    |
|  362 |   345 |  -13 |      2 |                    |
|  304 |   411 |   +1 |      1 |                    |
|  256 |   488 |   +8 |      2 | speaker resonance  |
|  215 |   581 |   +1 |      1 |                    |
|  181 |   691 |   -1 |      1 |                    |
|  152 |   822 |   -2 |      1 |                    |
|  128 |   977 |    0 |      0 | reference          |
|  108 |  1157 |   -2 |      1 |                    |
|   90 |  1389 |   -1 |      1 |                    |
|   76 |  1645 |   +3 |      1 |                    |
|   64 |  1953 |   +5 |      1 |                    |
|   54 |  2315 |   +9 |      1 |                    |
|   45 |  2778 |   +9 |      2 |                    |
|   38 |  3289 |   +2 |      3 |                    |
|   32 |  3906 |   +8 |      4 |                    |
|   27 |  4630 |   -1 |      6 |                    |
|   23 |  5435 |   -2 |      3 |                    |
|   19 |  6579 |  -16 |      3 |                    |
|   16 |  7813 |  -18 |      6 |                    |
|   13 |  9615 |  -18 |     10 |                    |
|   11 | 11364 |  -14 |      5 |                    |
|   10 | 12500 |  -24 |      6 |                    |
|    8 | 15625 |  -23 |      4 |                    |
|    7 | 17857 |  -29 |     20 |                    |
|    6 | 20833 |  -53 |     20 | at the noise floor |

What it says:

- A resonance around 490 Hz, +8 dB, then about 30 dB per octave below it. That is far steeper
  than the 423 Hz coupling-cap corner alone: it is a small driver's below-resonance roll-off
  stacked on C18 and C79. The machine produces nothing below 200 Hz.
- Roughly flat from 580 Hz to 1.4 kHz, then a broad +8 to +9 dB presence bump from 2 to 4 kHz.
- A cliff at 6 kHz: -16 dB by 6.6 kHz, -18 at 8 kHz, in the -20s above 12 kHz. jsbeeb's board
  filter is only -3.7 dB at 7.8 kHz, so most of this is the speaker.
- The spread widens above 6 kHz (5 cm wavelengths; a centimetre of microphone movement moves
  the interference pattern) and below 350 Hz (little signal). Marking the microphone position
  would tighten the top octave.
- The residual "whine" heard from sample-playback players after #919 sits at 3.5 to 3.7 kHz,
  inside the presence bump: the speaker is not hiding that content, so whatever makes it read
  differently on hardware is elsewhere (the 6 kHz cliff over its harmonics, or the playback
  routine's spectrum).

## Measurements, 2026-08-29: cable across the speaker terminals

Three takes with a lead from the speaker header into a CalDigit TS4 dock's rear line input,
through a home-made adapter that sits on PL9, offers a 3.5 mm socket, and switches the
speaker out when a plug is in. 16-bit mono 44.1 kHz. Take-to-take spread was 0.0 dB at every
step, the volume staircase read 2.0 dB per step, and the three level sweeps agree, so there
is no automatic gain in the chain. A fourth take with the speaker unplugged as well is
identical to within 0.3 dB. The gaps carry 60 Hz mains hum and its harmonics at about
-50 dBFS (a ground loop between the machine and the dock), well below every tone.

Relative to 977 Hz. "jsbeeb" is the shipped model's own response (the Sallen-Key), "measured"
is the voltage at the jack, "rel" is the difference, and the last column is the model plus a
first-order high-pass at 2 kHz and the C79 high-pass.

|    N |    Hz | jsbeeb | measured |   rel |             model + HP 2 kHz |
| ---: | ----: | -----: | -------: | ----: | ---------------------------: |
| 1023 |   122 |    0.0 |    -18.4 | -18.4 |                        -18.8 |
|  860 |   145 |    0.0 |    -16.4 | -16.4 |                        -16.9 |
|  723 |   173 |    0.0 |    -14.5 | -14.5 |                        -15.0 |
|  608 |   206 |    0.0 |    -12.8 | -12.8 |                        -13.3 |
|  512 |   244 |    0.0 |    -11.1 | -11.1 |                        -11.6 |
|  430 |   291 |    0.0 |     -9.6 |  -9.6 |                        -10.0 |
|  362 |   345 |    0.0 |     -8.1 |  -8.1 |                         -8.5 |
|  304 |   411 |    0.0 |     -6.6 |  -6.6 |                         -6.9 |
|  256 |   488 |    0.0 |     -5.2 |  -5.2 |                         -5.4 |
|  215 |   581 |    0.0 |     -3.8 |  -3.8 |                         -4.0 |
|  181 |   691 |    0.0 |     -2.5 |  -2.5 |                         -2.6 |
|  152 |   822 |    0.0 |     -1.2 |  -1.2 |                         -1.3 |
|  128 |   977 |    0.0 |      0.0 |   0.0 |                          0.0 |
|  108 |  1157 |    0.0 |      1.1 |   1.1 |                          1.2 |
|   90 |  1389 |    0.0 |      2.2 |   2.3 |                          2.3 |
|   76 |  1645 |    0.0 |      3.2 |   3.2 |                          3.2 |
|   64 |  1953 |    0.0 |      4.1 |   4.1 |                          4.1 |
|   54 |  2315 |   -0.1 |      4.9 |   4.9 |                          4.8 |
|   45 |  2778 |   -0.1 |      5.6 |   5.7 |                          5.4 |
|   38 |  3289 |   -0.2 |      6.1 |   6.3 |                          5.8 |
|   32 |  3906 |   -0.4 |      6.4 |   6.9 |                          6.2 |
|   27 |  4630 |   -0.8 |      6.5 |   7.2 |                          6.4 |
|   23 |  5435 |   -1.3 |      6.1 |   7.4 |                          6.6 |
|   19 |  6579 |   -2.4 |      4.9 |   7.3 |                          6.8 |
|   16 |  7813 |   -3.9 |      3.2 |   7.1 |                          6.9 |
|   13 |  9615 |   -6.3 |      0.6 |   6.9 |                          7.0 |
|   11 | 11364 |   -8.6 |     -1.4 |   7.2 |                          7.1 |
|   10 | 12500 |  -10.1 |     -2.6 |   7.5 |                          7.1 |
|    8 | 15625 |  -14.1 |     -5.7 |   8.5 |                          7.1 |
|    7 | 17857 |  -18.8 |     -8.0 |  10.7 |                          7.1 |
|    6 | 20833 |  -30.9 |    -37.6 |  -6.7 | recorder's anti-alias filter |

Two things follow, one settled and one not:

- **The Sallen-Key model is confirmed.** From 4.6 kHz to 12.5 kHz the shipped filter falls
  10 dB and the measurement tracks it within 0.3 dB (a constant `rel`). Above 12.5 kHz the
  real board has 1 to 3 dB more output than the model, a Q nearer 0.8 than 0.696 or the
  recorder; not worth chasing.
- **A first-order high-pass at about 2 kHz** accounts for everything else, to within 0.5 dB
  from 122 Hz up, and nothing on the board explains it. It is not the recorder: a loopback of
  the dock's line-out into the same line-in with `reference`'s WAV is flat within 0.4 dB from
  122 Hz to 17.9 kHz. It is not the load: the speaker was switched out for every cable take,
  so C18 saw only the dock's input, and 25µF or 47µF into kilohms corners below 1 Hz. It is
  not the parts, which were checked on the board (below). What is left is the path from the
  LM386's output through C18, the adapter and the lead to the dock, and a signal measurement
  is the way to place it.

### What was checked on the board

Master 128 issue 1 (silkscreen 0243,000 ISS.1), original ICs (SN76489AN, LM324, LM386N-1,
date codes 8628 and 630). Photographs of every part of the audio corner, plus multimeter
readings with the machine off:

| Part                 | Drawing           | Found                                                                                                                                   |
| -------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| C9, C12              | 2n2               | marked `2n2`                                                                                                                            |
| C79                  | 330nF             | marked `0.33 10% 63-`, Evox-Rifa MMK                                                                                                    |
| C10                  | 100nF             | 132nF in circuit                                                                                                                        |
| R26                  | 4K7               | 4K7 by bands                                                                                                                            |
| R13                  | 1K                | **2K2** by bands (moves the C79 corner from 85 Hz to 70 Hz)                                                                             |
| C18                  | 47µF 25V          | Philips `47µ-M 25V`, about 25µF in circuit (a meter across an amplifier output is unreliable, but consistent with a tired electrolytic) |
| IC13 pin 3 to ground | 50K (LM386 input) | 110K                                                                                                                                    |
| Speaker              | not documented    | 7.7 Ω DC, so an 8 Ω driver                                                                                                              |
| Adapter              |                   | open circuit across its speaker side with a plug in; no dummy load                                                                      |

The only rework visible is the speaker lead hand-soldered onto a connector body at PL9.

### The open question, and the test for it

Whether the 2 kHz corner exists in the voltage the speaker sees, or only in the cable path.
The microphone takes cannot tell: the speaker's own roll-off dominates below 500 Hz either
way. With an oscilloscope, two probes with a low tone (about 122 Hz) and a high one (about
2 kHz) playing, ground clip on IC13 pin 4:

1. IC13 pin 5, the LM386 output before C18. The drawing says the two tones are equal here.
2. The jack tip at the dock end, with the dock connected as for a capture.

If pin 5 is flat and the tip has the 18 dB difference, the corner is in C18, the adapter, the
lead or the dock's input, and unplugging the dock end (an open load) shows which. If pin 5
already differs, the corner is upstream and the next probes are IC9 pin 14 and the R13/R26
junction. Either way the board's design values stay as the defaults; what changes is whether
this machine has a defect worth documenting.

## Where this goes

- The oscilloscope test above, for the record; and a fresh 47µF in C18 with a before-and-after
  sweep would give both the design and the aged curves from the same machine, and a "speaker"
  fit for a healthy one.
- Repeat with a Model B, whose Sallen-Key is the same but which has the volume pot and no C79.
- A microphone with a known response, or two microphones, would separate the speaker from the
  Blue's own colour in the "speaker" fit.

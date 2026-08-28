# PAL Television Simulation for jsbeeb

**Status:** ✅ Implemented
**Author:** Claude Code
**Date:** October 2025
**Branch:** claude/pal
**PR:** #525 (DRAFT)

## Executive Summary

This document describes the PAL composite video simulation in jsbeeb, which adds authentic analog TV artifacts (dot crawl, color bleeding) that were part of the original BBC Micro viewing experience.

The implementation uses WebGL fragment shaders to simulate the complete PAL signal path: RGB → YUV encoding → composite signal → PAL decoding → RGB display. The approach uses **baseband chroma blending** with **complementary luma extraction**, achieving sharp luminance with smooth chrominance and no checkerboard artifacts.

**Performance:** Real-time 60fps on modern GPUs, ~1-2ms per frame.

## How It Works

### Signal Processing Pipeline

The shader implements these steps for each pixel:

1. **Encode to composite** (per horizontal tap)
   - Convert RGB → YUV using scaled matrix
   - Generate composite: `C(t) = Y + U·sin(ωt) + V·cos(ωt)·v_switch`
   - Where v_switch alternates ±1 each scanline (PAL phase)

2. **Demodulate with FIR filter**
   - Multiply composite by sin(ωt) and cos(ωt) to shift chroma to baseband
   - Apply 21-tap FIR low-pass filter (1.108 MHz design cutoff, -3 dB at about 0.83 MHz) horizontally
   - FIR_GAIN = 2.0 compensates for demodulation amplitude loss (sin²(x) = 0.5)
   - Process current line AND previous line (2H delay) separately

3. **Blend chroma at baseband**
   - Mix current and previous line's U/V values: 50/50 weighted average
   - **Critical:** Blend AFTER demodulation to avoid phase mixing
   - Exploits slow vertical chroma changes for noise reduction

4. **Extract luma via complementary subtraction**
   - Remodulate blended chroma back to composite frequency
   - Subtract from current line's composite: `Y_out = composite - chroma_remod`
   - Gives sharp luma without vertical averaging

5. **Convert back to RGB** for display

### Why This Approach Works

**Baseband blending avoids U/V corruption:**

- Each line demodulated with its correct PAL phase FIRST
- Then clean U and V components blended (no phase mixing)
- Contrast with failed approaches that blended at composite level

**Complementary decoder preserves luma sharpness:**

- Luma extracted by subtraction, not averaging
- Avoids vertical blur from comb filters
- Slightly less sharp than notch filter, but more authentic

**Texture rows are half-lines:**

- The framebuffer holds two rows per scanline: the non-interlaced modes double each scanline onto both, and an interlaced field draws every other row
- The previous scanline of the same field is two rows up in every mode, so the chroma blend samples row-2
- Phase and V-switch come from the scanline's line number, which video.js records per row parity (see "Line Number Propagation")

## Evolution: What Was Tried and Why

### The Investigation Journey

Initial implementation suffered from excessive vertical blur and/or checkerboard artifacts. The investigation tested multiple approaches to Y/C separation and chroma filtering:

### Failed Approaches

#### 1. 1H Comb Bandpass at Composite Level (Approach C)

Inspired by BBC decoder schematic from Jim Easterbrook's PAL decoder page.

**Approach:**

```glsl
chroma_band = (composite_curr + composite_prev_1H) / 2.0;
// Demodulate chroma_band with FIR → U, V
Y = composite_curr - remodulated_chroma;
```

**Why it failed:**

- The delay used was one whole 1024-texel texture line, which is 64 µs = 283.75 subcarrier cycles, so the delayed chroma arrived 270° from the direct chroma and the sum mixed U into V and V into U:
  ```
  chroma_band = (U_N + V_{N-1})·sin(ωt) + (V_N + U_{N-1})·cos(ωt)
  ```
- When demodulated, extracted corrupted U/V values (phase mixing)
- Tried compensating with FIR_GAIN = 4.0 (double amplitude loss) - made it worse
- Result: Severe checkerboard artifacts, washed out colors

**Lesson:** A 1H comb at composite level does work for PAL; every delay-line PAL set uses one. The glass delay line is 63.943 µs (283.5 cycles), not 64 µs, precisely so the delayed chroma is 180° from the direct chroma. Reproducing that needs a 283.5-cycle delay (about 1023.1 texels), not a whole texture line. Demodulating first and blending at baseband sidesteps the requirement, which is what the shipped design does.

#### 2. 3-Tap Bandpass Comb with Complementary Subtraction

**Approach:**

```glsl
chroma = -0.25*prev + 0.5*curr - 0.25*next;  // "Bandpass"
y_out = composite_curr - chroma;             // Complementary
```

**Why it failed:**
Mathematical reduction negates the negative coefficients:

```
y_out = composite_curr - (-0.25*prev + 0.5*curr - 0.25*next)
      = 0.25*prev + 0.5*curr + 0.25*next  // Standard lowpass!
```

Result: Luma averaged across 4 scanlines (N-2 to N+2 span), excessive blur.

**Validation:** Explicit lowpass produced IDENTICAL blur (toggled multiple times to confirm).

**Lesson:** Complementary subtraction with this 3-tap design mathematically collapses to simple averaging.

#### 3. Various 2-Tap Comb Filters Without Proper Gain

**Approach:**

```glsl
// Tried various weightings
y = 0.5*prev + 0.5*curr;     // 50/50
y = 0.25*prev + 0.75*curr;   // 25/75
y = 0.33*prev + 0.67*curr;   // 33/67
```

**Why they failed:**
All showed checkerboard artifacts with FIR_GAIN = 1.0.

**Root cause identified:** The issue wasn't the comb filter design - it was insufficient gain compensation!

- Demodulation: `composite * sin(ωt)` produces baseband at 0.5× amplitude (sin²(x) identity)
- With FIR_GAIN = 1.0: Only removed HALF the chroma from luma
- Result: Residual chroma in luma channel → checkerboard

**Fix:** FIR_GAIN = 2.0 properly compensates for demodulation amplitude loss.

**Lesson:** This was THE fundamental bug causing most artifacts. Weight tuning was papering over a deeper mathematical issue.

#### 4. Active Video Only Phase Calculation

**Approach:**

```glsl
cycles_per_pixel = 230.0 / 896.0;  // Subcarrier over visible pixels only
```

**Why it failed:**

- Ignored blanking periods (horizontal retrace)
- Subcarrier runs continuously through blanking
- Wrong phase relationships between lines

**Fix:** Use full scanline: 283.75 cycles / 1024 pixels (includes blanking).

#### 5. Comb Filter Without Temporal Phase

**Approach:**

```glsl
y = (composite_curr + composite_prev) / 2.0;  // Simple average
```

**Why it failed:**

- Didn't account for 0.75 cycle phase offset between lines
- Result: Heavy vertical striping (chroma not canceling properly)

**Fix:** Added `line_phase_offset = line * 0.7516` for proper phase relationships.

#### 6. Horizontal Bandwidth Limiting of Composite Signal

**Approach:**
Apply horizontal low-pass filter to composite signal before Y/C separation.

**Why it failed:**

- Didn't address root cause of artifacts
- Just added blur without fixing underlying issues
- Abandoned as unnecessary once phase and gain issues were fixed

The set's own bandwidth limits are a different matter. A stock BBC Micro's colour picture reached
the set by UHF through the UM1233 modulator, so every bandwidth here is an RF-path figure: the IF
strip rolls off below the sound carrier, which clips the upper chroma sideband (chroma -3 dB at
about 0.83 MHz) and delivers luma to about 4.5 MHz (-6 dB); a domestic set's luma path is the
composite through that low-pass and a subcarrier trap at 4.43361875 MHz, with no complementary
subtraction of the decoded chroma. No sound trap: nothing rendered here carries a sound carrier.

### Working Approaches (Evolution)

#### Early Success: 2H Comb Filter with Weighted Coefficients

**Approach:**

```glsl
luma = COMB_PREV_WEIGHT * prev_2H + (1-COMB_PREV_WEIGHT) * current;
```

- Uses 2H (2-line) spacing for proper PAL phase (180° inversion)
- Tunable weighting via COMB_PREV_WEIGHT (0.33 was final setting)
- FIR_GAIN = 2.0 for proper demodulation compensation

**Status:** Working and producing good results, but superseded by sharper Approach D.

**Result:** Good Y/C separation, authentic dot crawl, but more vertical blur than final approach.

#### Final Success: Baseband Chroma Blending (Current Implementation)

**Key insight from PAL decoder expert:** "Improve the decoded chroma" - blend AFTER demodulation, not before.

**Approach:**

1. Demodulate current and previous (2H for interlaced) lines separately
2. Each demodulation uses correct phase for that line (avoids U/V mixing)
3. Blend clean U/V at baseband: `mix(uv_curr, uv_prev, 0.5)`
4. Extract luma via complementary subtraction from composite
5. FIR_GAIN = 2.0 for proper amplitude compensation

**Why this works:**

- **Phase-correct demodulation first:** Each line processed with its own PAL phase
- **Baseband blending:** No U/V mixing (pure U with U, pure V with V)
- **Complementary decoder:** Luma from composite minus remodulated chroma (sharp)
- **Proper gain compensation:** FIR_GAIN = 2.0 handles demodulation loss only

**Result:**

- Sharp luma with slight authentic blur (no vertical averaging of composite)
- Smooth chroma (vertical blending exploits slow chroma changes)
- Good color saturation (no phase corruption)
- No checkerboard artifacts (clean Y/C separation)

**Comparison with notch filter approach:**

- Pure notch filter (luma = composite - FIR_filtered_chroma) was tested
- With FIR_GAIN = 2.0, it's super sharp with no checkerboard
- BUT: Too sharp - sharper than authentic PAL TVs
- Current approach has more authentic slight blur

### Critical Technical Discoveries

1. **Demodulation amplitude loss MUST be compensated**
   - sin²(x) = 0.5 - 0.5·cos(2x) → baseband has 0.5× amplitude
   - FIR_GAIN = 2.0 compensates for this loss
   - This was the root cause of most checkerboard artifacts

2. **"Blend chroma" means at baseband, not composite**
   - Composite-level blending causes phase mixing
   - Baseband-level blending preserves clean U/V separation

3. **Texture coordinates represent full scanline**
   - 1024px = 64μs complete scanline (visible + blanking)
   - Phase must map across full width, not just visible pixels

4. **The "0.75 cycle offset" is essential**
   - 1H spacing = 270° phase shift
   - 2H spacing = 180° phase shift (used for PAL cancellation)
   - This fractional offset creates the 8-field dot crawl pattern

5. **Properly scaled YUV matrix eliminates separate gain constant**
   - ITU-R BT.470-6 defines white at 0.7V, peak at 0.931V
   - Baking this into the RGB→YUV matrix removes need for CHROMA_GAIN
   - Cleaner implementation, one less magic number

## Technical Reference

### PAL Parameters

- **Subcarrier frequency:** 283.7516 cycles per scanline (4.43361875 MHz over 64μs)
- **Line phase offset:** 0.7516 fractional cycles per line, so the residual dot pattern repeats every four lines
- **Frame phase step:** whatever the frame's line count gives. The Beeb's usual 312-line non-interlaced frame steps 0.4992 cycles, so the dots nearly invert every frame (a 25 Hz twinkle) and drift through a cycle in about 50 s; a 312.5-line interlaced field steps 0.375 cycles
- **V phase alternation:** ±1 per scanline (PAL's defining characteristic)
- **Phase period:** 0.7516 = 1879 / 2500, so the line counter that drives the phase wraps at 2500 lines and never drifts

### Color Space Conversion

Uses ITU-R BT.470-6 YUV matrix scaled for PAL signal levels:

- RGB(1,1,1) → YUV(0.7, 0, 0) — white at 0.7V
- Worst case (yellow) peaks at 0.931V — prevents overmodulation
- No separate CHROMA_GAIN needed (baked into matrix coefficients)

See shader source for actual matrix values.

### FIR Filter

- **Taps:** 21 (symmetric), Kaiser window with β=5
- **Cutoff frequency:** 1.108 MHz design cutoff (quarter subcarrier), which for a windowed sinc is the -6 dB point
- **Measured response:** -1.05 dB at 0.5 MHz, -3 dB at 0.83 MHz, -5.6 dB at 1.108 MHz, -32 dB at 2.2 MHz, -86 dB at 4.43 MHz
- **Why this narrow:** the picture came in by UHF, and the IF strip's roll-off below the sound carrier clips the upper chroma sideband to about 0.83 MHz at -3 dB
- **Sample rate:** 16 MHz
- **Gain compensation:** FIR_GAIN = 2.0 to compensate for demodulation amplitude loss
- **Source:** Derived from svofski/CRT project

### Chroma Blending

50/50 weighted average of current and previous line's U/V components (at baseband, after demodulation).

## Known Limitations

### Not Yet Implemented

- User-adjustable parameters (artifact intensity, etc.)
- Quality presets (composite/s-video/rgb simulation modes)
- Toggle to switch between PAL and clean RGB
- Performance monitoring

### Outstanding Issues

1. **Edge artifacts at borders**
   - Visible color fringe where content meets black border
   - Caused by chroma blending with black (correct behavior)
   - May need comparison with real hardware to validate

### Gamma

No gamma handling is needed, and an sRGB framebuffer would be the wrong direction. PAL encoders work on gamma-corrected R'G'B' and the decoder's R'G'B' output goes to the display as-is, so the whole chain runs on gamma-coded values. With one bit per gun the YUV matrix gives the same result either way, and NULA palette values are already gamma-coded.

## Integration with jsbeeb

### Line Number Propagation

`video.js` counts hsyncs in `hsyncCount`, modulo 2500, and at each flyback records the count that texture rows 0 and 1 are about to be drawn under (`lineBaseEven`, `lineBaseOdd`): the even field's row 0 is the rest of the line the vsync fell in, the odd interlaced field's row 1 is the first hsync after it, and a doubled scanline gives both rows the same line. Row `r` was drawn during line `lineBase[r & 1] + (r >> 1)`. In interlaced modes the texture holds both fields, so each parity keeps the base from its own field's flyback. The bases travel with each painted frame:

```javascript
// video.js → main.js → canvas.js → shader
video.lineBaseEven, video.lineBaseOdd → gl.uniform2f(uLineBase, even, odd)
```

The shader takes `line = uLineBase[row & 1] + floor(row / 2)`, the V-switch from the line's parity and `phase = fract(line * 0.7516)`; the previous scanline of the same field is `line - 1`, two rows up. Nothing is reset per frame, so the phase steps between frames by the frame's true line count.

### Interlaced Rendering Interaction

jsbeeb simulates interlacing by clearing alternate lines each frame:

- Even frames: render lines 1,3,5... (clear 0,2,4...)
- Odd frames: render lines 0,2,4... (clear 1,3,5...)

The shader's 2H delay (line-2) ensures we sample from the same field, avoiding stale/black data.

## References

### PAL Standards

- ITU-R BT.470-6 (1998): PAL signal levels and YUV coefficients
- ITU-R BT.601: Digital video encoding

### BBC Micro Hardware

- BBC Hardware Guide: PAL encoder circuit, subcarrier generation
- BeebWiki Video ULA: RGB output and palette

### Decoding Theory

- Watkinson "Engineer's Guide to Encoding & Decoding": Comb filter principles
- Jim Easterbrook PAL decoder page: Complementary decoder approach
- svofski/CRT project: FIR filter coefficients source

### WebGL Implementation

- WebGL Fundamentals: Shader optimization techniques
- MDN WebGL Best Practices: Performance guidelines

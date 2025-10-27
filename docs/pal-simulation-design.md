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
   - Apply 21-tap FIR low-pass filter (~2.2 MHz cutoff) horizontally
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

**2H delay for interlaced rendering:**

- jsbeeb renders only odd OR even lines per frame
- Using line-2 samples from same field (both fresh data)
- Represents TV's 1H delay within a single field

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

- 1H spacing = 0.75 cycles = 270° phase shift
- Mathematical analysis showed U/V mixing:
  ```
  chroma_band = (U_N + V_{N-1})·sin(ωt) + (V_N + U_{N-1})·cos(ωt)
  ```
- When demodulated, extracted corrupted U/V values (phase mixing)
- Tried compensating with FIR_GAIN = 4.0 (double amplitude loss) - made it worse
- Result: Severe checkerboard artifacts, washed out colors

**Lesson:** 1H comb at composite level doesn't work for PAL due to phase relationships. Must demodulate FIRST with correct phase, THEN blend.

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

- **Subcarrier frequency:** 283.75 cycles per scanline (4.43 MHz over 64μs)
- **Line phase offset:** 0.7516 fractional cycles per line
- **Field phase offset:** 234.875 cycles per field (= 0.7516 × 312.5 lines)
- **V phase alternation:** ±1 per scanline (PAL's defining characteristic)
- **8-field sequence:** Phase repeats every 8 fields, creating animated dot crawl

### Color Space Conversion

Uses ITU-R BT.470-6 YUV matrix scaled for PAL signal levels:

- RGB(1,1,1) → YUV(0.7, 0, 0) — white at 0.7V
- Worst case (yellow) peaks at 0.931V — prevents overmodulation
- No separate CHROMA_GAIN needed (baked into matrix coefficients)

See shader source for actual matrix values.

### FIR Filter

- **Taps:** 21 (symmetric)
- **Cutoff frequency:** 2.217 MHz (half subcarrier)
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

1. **Non-interlaced mode sub-optimal**
   - Current: Uses same 2H delay as interlaced (blends same-phase lines)
   - Better: Should use 1H delay (blend opposite-phase lines N and N-1)
   - Impact: Less accurate chroma in non-interlaced modes
   - Fix: Add `uInterlaced` uniform, use `line_offset = interlaced ? 2.0 : 1.0`

2. **Fixed field line count**
   - Assumes 312.5 lines/field for phase calculation
   - CRTC can configure variable line counts
   - May affect dot crawl accuracy in unusual configurations

3. **Edge artifacts at borders**
   - Visible color fringe where content meets black border
   - Caused by chroma blending with black (correct behavior)
   - May need comparison with real hardware to validate

4. **No gamma correction**
   - Should ideally use sRGB framebuffer (GL_FRAMEBUFFER_SRGB)
   - Deferred for future implementation

## Integration with jsbeeb

### Frame Counter Propagation

The 8-field PAL sequence requires frame-accurate phase:

```javascript
// video.js → main.js → canvas.js → shader
video.frameCount → gl.uniform1f(frameCountLocation, frameCount)
```

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

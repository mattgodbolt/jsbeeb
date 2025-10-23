# PAL Television Simulation for jsbeeb

**Status:** ✅ Implemented (Work in Progress)
**Author:** Claude Code
**Date:** October 2025
**Branch:** claude/pal
**PR:** #525 (DRAFT)

## Executive Summary

This document outlines the plan and actual implementation of authentic PAL composite video simulation for jsbeeb, adding the characteristic artifacts (dot crawl, color bleeding, etc.) that were part of the original BBC Micro television viewing experience.

The implementation uses WebGL fragment shaders to perform real-time PAL encoding and decoding, simulating the analog composite video signal path from the BBC Micro's RGB output through a PAL encoder, composite transmission, and PAL decoder in a television set.

**Current Status:** Working prototype with authentic PAL artifacts. See Implementation Status below for what was implemented vs. planned.

## Implementation Status

### What Was Actually Implemented ✅

**Core PAL Simulation:**

- ✅ Full PAL encoding to composite signal: `Y + U*sin(ωt) + V*cos(ωt)*phase`
- ✅ Proper PAL subcarrier frequency: 283.75 cycles per scanline
- ✅ Correct vertical phase accumulation: 0.75 cycles per line
- ✅ PAL 4-field temporal sequence with frame counter
- ✅ 2-line comb filter for luma extraction (authentic to real PAL TVs)
- ✅ 20-tap FIR low-pass filter for chroma (~1.3 MHz bandwidth)
- ✅ Proper YUV color space conversion (ITU-R BT.470-2)

**Integration:**

- ✅ Frame counter wired through video.js → main.js → canvas.js → shader
- ✅ Works with existing GlCanvas WebGL infrastructure
- ✅ All tests passing

**Performance:**

- ✅ Real-time 60fps performance on target hardware
- ✅ GPU-accelerated via WebGL fragment shader

### What Worked vs. What Didn't

**✅ Approaches That Worked:**

1. **Baseband Chroma Blending + Complementary Decoder** (APPROACH D - CURRENT IMPLEMENTATION)
   - Demodulates current and previous (1H) scanlines separately with correct phase
   - Blends U/V at baseband (after demodulation) to avoid phase mixing
   - Extracts luma via complementary subtraction from composite
   - Tunable chroma blending via CHROMA_BLEND_WEIGHT (currently 0.5)
   - Result: Sharp luma with slight authentic blur, smooth chroma, good color saturation, no checkerboard
   - Key insight: Demodulate FIRST with correct phase, THEN blend (avoids U/V corruption)

2. **2H Comb Filter with Weighted Coefficients** (SUPERSEDED BY APPROACH D)
   - Uses 2H (2-line) spacing for proper PAL phase relationships (180° inversion)
   - Tunable weighting via COMB_PREV_WEIGHT constant (0.33 was final setting)
   - Formula: `luma = COMB_PREV_WEIGHT * prev_2H + (1-COMB_PREV_WEIGHT) * current`
   - Result: Good Y/C separation but more vertical blur than Approach D
   - Status: Working but superseded by sharper Approach D

3. **FIR_GAIN = 2.0 for Chroma Demodulation** (ESSENTIAL)
   - Compensates for demodulation amplitude loss (sin²(x) = 0.5 - 0.5·cos(2x))
   - Without this, only HALF the chroma was removed from luma
   - THIS was the root cause of all checkerboard artifacts
   - Result: Clean Y/C separation, minimal checkerboard

4. **20-tap FIR Filter for Chroma**
   - Demodulate first, then filter (not filter composite then demodulate)
   - Limits chroma bandwidth to ~1.3 MHz as per PAL spec
   - Coefficients from svofski/CRT project
   - Result: Good color reproduction, proper bandwidth limiting

5. **Full Scanline Phase Calculation**
   - Maps 283.75 cycles across full 1024-pixel texture width
   - Includes blanking periods in phase calculation
   - Result: Correct temporal phase relationships

**❌ Approaches That Failed:**

1. **1H Comb Bandpass + Complementary Decoder** (APPROACH C - FAILED)
   - **Source**: BBC decoder schematic from Jim Easterbrook's PAL decoder page
   - **Approach**: Use 1H comb as BANDPASS to extract chroma at composite level, then complementary subtraction
   - **Implementation**:
     ```
     chroma_band = (composite_curr + composite_prev_1H) / 2.0
     Demodulate chroma_band with FIR → U, V
     Y = composite_curr - remodulated_chroma
     ```
   - **Problem**: 270° phase shift from 1H spacing causes U/V mixing
     - Mathematical analysis: chroma*band = (U_N + V*{N-1})·sin(ωt) + (V*N + U*{N-1})·cos(ωt)
     - When demodulated, extracted corrupted U/V values
   - **Result**: Severe checkerboard artifacts, washed out colors
   - **Attempted fix**: FIR_GAIN = 4.0 to compensate for double amplitude loss (comb + demodulation)
     - Made checkerboard worse, colors still washed out
   - **Why it failed**: Fundamental phase mixing issue, not amplitude problem
   - **Key learning**: 1H comb at composite level doesn't work for PAL due to phase relationships
     - Must demodulate first, THEN blend

2. **Notch Filter for Luma** (RECONSIDERED)
   - Approach: Subtract re-modulated FIR-filtered chroma from composite
   - ORIGINAL ASSESSMENT: Wide FIR filter caused premature edge artifacts
   - RE-TESTED: With FIR_GAIN = 2.0, NO edge artifacts, super sharp, no checkerboard
   - However: Sharper than authentic PAL TVs (less blur than real hardware)
   - Status: Works correctly but less authentic than comb filter

3. **Comb Filter WITHOUT Temporal Phase** (FIXED)
   - Approach: Average current and previous scanlines
   - Problem: Didn't account for 0.75 cycle phase offset between lines
   - Result: Heavy vertical striping (chroma not properly canceling)
   - Why it failed: Phase relationship between lines was incorrect
   - Fixed by adding `line_phase_offset = line * 0.75`

4. **Horizontal Bandwidth Limiting of Composite** (ABANDONED)
   - Approach: Apply horizontal low-pass filter to composite signal
   - Rationale: Simulate bandwidth limits of real video circuits
   - Problem: Didn't address root cause of artifacts
   - Result: Just added blur without fixing issues
   - Abandoned as unnecessary once comb filter phase was fixed

5. **Active Video Only Phase Calculation** (ABANDONED)
   - Approach: Calculate 230 cycles over 896 visible pixels only
   - Problem: Ignored blanking periods, incorrect phase
   - Result: Wrong subcarrier frequency mapping
   - Fixed by using full scanline (283.75 / 1024)

6. **1H (1-line) Comb Filter Spacing** (ABANDONED - NTSC-style)
   - Approach: Use line N and line N-1 with 0.75 cycle (270°) phase difference
   - Problem: 270° phase shift causes U/V rotation, not cancellation
   - Result: Checkerboard artifacts on solid colors due to U/V mixing
   - Fixed by switching to 2H (2-line) spacing per Watkinson's guide
   - Why 2H works: 1.5 cycles = 540° = 180° (mod 360°) for proper phase inversion

7. **3-tap Bandpass Comb with Complementary Subtraction** (ABANDONED)
   - Approach: Use -0.25, +0.5, -0.25 coefficients for "bandpass" chroma extraction
   - Then: Subtract from current line to get luma (complementary decoder)
   - Problem: Mathematical reduction negates the negative coefficients:
     ```
     y_out = composite_curr - (-0.25*prev + 0.5*curr - 0.25*next)
           = 0.25*prev + 0.5*curr + 0.25*next  // Standard lowpass!
     ```
   - Test A verified: Explicit lowpass produces IDENTICAL blur
   - Result: Luma averaged across 4 scanlines (N-2 to N+2), excessive blur
   - Abandoned: Complementary approach doesn't work as intended with 3-tap comb

8. **2-tap Comb with FIR_GAIN = 1.0** (ABANDONED)
   - Various weightings tested: 50/50, 25/75, 33/67
   - All showed checkerboard artifacts
   - Root cause: FIR_GAIN = 1.0 only removed HALF the chroma from luma
   - Resolution: Fixed by setting FIR_GAIN = 2.0 (proper demodulation compensation)

### Current Issues and Limitations

**Known Issues:**

- ✅ **RESOLVED: Blur and checkerboard issues** (October 2025)
  - Root cause identified: FIR_GAIN = 1.0 was incorrect
  - Fixed: FIR_GAIN = 2.0 compensates for demodulation amplitude loss
  - Current implementation uses tunable 2H comb filter (COMB_PREV_WEIGHT = 0.33)
  - Good balance of sharpness and Y/C separation
  - See "Blur Investigation" section below for full details

**Not Yet Implemented (from original design):**

- ❌ User-adjustable parameters (artifact intensity, etc.)
- ❌ Quality presets (composite/s-video/rgb simulation modes)
- ❌ Toggle to switch between PAL and clean RGB
- ❌ Adaptive quality based on performance
- ❌ Performance profiling/monitoring

**Deliberate Simplifications:**

- Using notch filter would be simpler but less authentic
- Could reduce FIR taps for performance (but quality suffers)
- No edge detection or adaptive filtering (real TVs didn't have this)

## Blur Investigation (October 2025)

### Problem Statement

The current implementation exhibits excessive blur compared to authentic PAL televisions. While PAL TVs were inherently blurry due to comb filtering, the current level of blur makes content difficult to read and appears worse than real hardware.

### Confirmed Observations

- ✅ Excessive vertical blur (confirmed by user testing)
- ✅ Good chroma separation - no checkerboard artifacts in solid colors
- ✅ Proper 2H comb spacing with 180° phase inversion
- ✅ Correct temporal dot crawl animation (4-field sequence)

### Working Hypothesis

**Current implementation** (lines 222-228 in pal-composite.js):

```glsl
chroma_from_comb = -0.25 * composite_prev + 0.5 * composite_curr - 0.25 * composite_next;
y_out = composite_curr - chroma_from_comb;
```

**Mathematical expansion:**

```
y_out = composite_curr - (-0.25*composite_prev + 0.5*composite_curr - 0.25*composite_next)
y_out = composite_curr + 0.25*composite_prev - 0.5*composite_curr + 0.25*composite_next
y_out = 0.25*composite_prev + 0.5*composite_curr + 0.25*composite_next
```

**Hypothesis:** This may reduce to a standard lowpass comb filter with POSITIVE coefficients (+0.25, +0.5, +0.25), which would average luma across 4 scanlines (N-2, N-1, N, N+1, N+2 span), potentially causing the observed excessive blur.

**Status:** ✅ **CONFIRMED** - Test A verified hypothesis. Explicit lowpass produces identical blur when toggled multiple times. The complementary subtraction approach mathematically collapses to a simple averaging filter.

### Investigation Questions

1. **Does the math match reality?**
   - Try different coefficients to verify the mathematical reduction is causing the blur

2. **Is 3-tap (4-line span) too much?**
   - Historical context: Earlier sessions found 2-tap had less blur but more checkerboard
   - Question: Can we find a middle ground?

3. **Is "complementary decoder" being misunderstood?**
   - Watkinson shows standard comb with positive coefficients for luma
   - Jim Easterbrook describes "complementary" as chroma extraction + delayed subtraction
   - Question: Are we implementing the wrong variant?

4. **Do we need different filter design?**
   - Maybe complementary approach requires more taps for true bandpass
   - Maybe we need different coefficient ratios
   - Question: What did real PAL TVs actually use?

### References Consulted

**Watkinson "Engineer's Guide to Decoding & Encoding" (page 37):**

- Shows standard PAL comb filters with POSITIVE coefficients: +0.25, +0.5, +0.25
- This is explicitly for luma extraction (lowpass)
- Creates averaging across lines

**Jim Easterbrook PAL decoder page:**

- Line 311: "Some form of filter is used to extract the modulated chrominance from a PAL signal. Subtracting this chrominance from a suitably delayed PAL signal then yields luminance"
- Describes "complementary decoder" principle
- BBC transform decoder: Uses Fourier transforms (much more sophisticated than simple comb)

### Proposed Experiments

**Test A: Verify the math hypothesis**

- Change to explicit positive coefficients: `y_out = 0.25*prev + 0.5*curr + 0.25*next`
- If blur is IDENTICAL, hypothesis confirmed
- If blur CHANGES, something else is going on

**Test B: Try 2-tap comb (reduce span)**

- Use only lines N-2 and N (2 taps instead of 3)
- Reduces span from 4 lines to 3 lines
- May trade some chroma separation for less blur
- Code change: Remove `composite_next` term

**Test C: Try standard Watkinson approach**

- Extract luma with positive comb: `y = 0.25*prev + 0.5*curr + 0.25*next`
- Get chroma by subtraction: `chroma = composite - y`
- This is the "textbook" approach from Watkinson
- Compare blur vs current implementation

**Test D: Adjust coefficient ratios**

- Try different weighting: -0.5, +1.0, -0.5 (stronger center)
- Try asymmetric: -0.25, +1.0, -0.75
- See if coefficient tuning can preserve chroma separation while reducing blur

### Historical Context from Earlier Sessions

- Both 2-tap and 3-tap approaches were explored previously
- 3-tap had better chroma separation (less checkerboard) but more blur
- 2-tap had less blur but more checkerboard artifacts in solid colors
- Switched from 1H to 2H spacing to fix 270° phase issue
- This suggests fundamental tradeoff: chroma separation ↔ vertical resolution

### Test Results (October 2025)

**Test A: Verify mathematical hypothesis** ✅ CONFIRMED

- Changed to explicit lowpass: `y_out = 0.25*prev + 0.5*curr + 0.25*next`
- Result: IDENTICAL blur to original complementary approach (toggled multiple times)
- Conclusion: Hypothesis confirmed - complementary subtraction collapses to simple lowpass

**Test E: No comb filter (sharp baseline)** ✅ COMPLETED

- Used clean luma from source: `y_out = yuv_curr.x`
- Result: Very sharp, few artifacts
- Observation: TOO sharp - missing subtle color artifacts expected from PAL
- Note: Real TVs couldn't do this (need some Y/C filtering)

**Test B: 2-tap comb (50/50 average)** ✅ COMPLETED

- Used: `y_out = 0.5*prev + 0.5*curr` (2H spacing)
- Result: Better sharpness than 3-tap, color artifacts returned (dot crawl visible)
- Observation: Still blurrier than recalled authentic PAL TVs

**Test B Weighted: 2-tap with 25/75 coefficients** ✅ COMPLETED

- Used: `y_out = 0.25*prev + 0.75*curr`
- Result: Much better sharpness, subtle color artifacts present
- Observation: Getting close to authentic PAL blur levels
- PROBLEM: Checkerboard artifacts more pronounced than expected in solid colors
- **CONCERN**: Weight tuning might be papering over a fundamental bug rather than addressing root cause

**RE-TEST: Notch filter (svofski approach)** ✅ COMPLETED - FOUND ROOT CAUSE!

- Used: `y_out = composite_curr - remodulated_chroma` (subtract FIR-filtered chroma from composite)
- Result: Super sharp, no blur
- **UNEXPECTED**: NO premature edge artifacts (contrary to original abandonment reason!)
- Initial problem: Checkerboard artifacts (chroma leaking into luma)
- **ROOT CAUSE IDENTIFIED**: FIR_GAIN was 1.0, should be 2.0!
  - Demodulation math: composite × sin(ωt) yields 0.5×U after low-pass (sin² identity)
  - With gain=1.0: Only removed HALF the chroma from luma → checkerboard
  - With gain=2.0: Properly compensates for amplitude loss → chroma fully removed
- **FIXED**: Changed FIR_GAIN from 1.0 to 2.0
- Result after fix: Checkerboard GONE, sharp, good color saturation
- **MAJOR FINDING**: This was the fundamental bug causing all our issues!

### Resolution

**FINAL SOLUTION: Baseband Chroma Blending (Approach D)**

After extensive investigation and multiple failed approaches:

1. **Root cause identified:** Previous approaches either:
   - Mixed U/V during 1H comb at composite level (Approach C - phase mixing)
   - Or averaged luma vertically causing excessive blur (2H comb)

2. **Key insight from PAL decoder expert:** "improve the decoded chroma" - blend AFTER demodulation
   - Demodulate each line with its correct phase FIRST
   - Then blend the clean U/V components at baseband
   - This avoids phase mixing that corrupts chroma

3. **Current implementation (Approach D):**
   - Demodulate current and previous (1H) scanlines separately
   - Each demodulation uses correct phase for that line (avoids U/V mixing)
   - Blend U/V at baseband with tunable weight (CHROMA_BLEND_WEIGHT = 0.5)
   - Extract luma via complementary subtraction from composite
   - FIR_GAIN = 2.0 for proper demodulation amplitude compensation

4. **Results:**
   - Sharp luma with slight authentic blur (no vertical averaging of composite)
   - Smooth chroma (vertical blending exploits slow chroma changes)
   - Good color saturation (no phase corruption)
   - No checkerboard artifacts (clean Y/C separation)

5. **Why this works:**
   - Phase-correct demodulation: Each line processed with its own PAL phase
   - Baseband blending: No U/V mixing (pure U with U, pure V with V)
   - Complementary decoder: Luma from composite path (authentic signal processing)
   - Proper gain compensation: FIR_GAIN = 2.0 for demodulation loss only

6. **Alternative approaches in git history:**
   - 2H comb: Good but more blur than Approach D
   - 1H bandpass (Approach C): Phase mixing caused checkerboard
   - Notch filter alone: Very sharp but missing vertical chroma structure

**Conclusion:** The key was understanding that "blending chroma between lines" meant blending AFTER demodulation (at baseband), not before. This avoids the phase mixing issues that plagued Approach C while keeping luma sharp.

### Key Learnings

1. **Phase-correct demodulation before blending is essential**
   - Blending at composite level (1H comb before demod) causes U/V mixing at 270° phase
   - Must demodulate each line with its correct phase FIRST
   - Then blend the clean U/V components at baseband
   - This was the key insight that made Approach D work after Approach C failed

2. **Demodulation amplitude loss must be compensated**
   - When demodulating with sin(ωt), the trig identity sin²(x) = 0.5 - 0.5·cos(2x) means baseband has 0.5× amplitude
   - FIR_GAIN = 2.0 compensates for this loss
   - Without proper gain, only half the chroma is removed from luma → checkerboard artifacts

3. **"Improve the decoded chroma" means post-demodulation processing**
   - Advice to "blend chroma between lines" means at baseband, not composite
   - Vertical comb filters work differently depending on where in the signal chain they're applied
   - Composite-level: Creates phase mixing (Approach C failure)
   - Baseband-level: Clean blending of separated U/V (Approach D success)

4. **The "bit" in "delayed by a line and a bit" is critical**
   - The 0.75 cycle phase offset between lines is essential for proper phase relationships
   - 1H spacing = 270° phase shift (exploited for bandpass OR causes mixing)
   - 2H spacing = 180° phase shift (used for cancellation in comb filters)

5. **Texture coordinates represent full scanline, not just visible**
   - 1024px = 64μs complete scanline (displayed + blanking)
   - Subcarrier runs continuously through blanking
   - Must map phase across full width, not just visible region

6. **Mathematical phase analysis reveals bugs**
   - Carefully working through trig identities showed U/V mixing in Approach C
   - chroma*band = (U_N + V*{N-1})·sin + (V*N + U*{N-1})·cos
   - No amount of gain compensation could fix this fundamental corruption

7. **Research and verification are critical**
   - Don't assume early decisions were correct - revisit and test
   - Test with solid colors to see checkerboard artifacts clearly
   - User feedback is essential ("too sharp" revealed we were cheating)

## Background and Motivation

### Current State

jsbeeb currently outputs clean RGB pixels directly to the display, which accurately represents the BBC Micro connected to an RGB monitor. However, many users experienced the BBC Micro through a television set using composite video, which introduced distinctive visual artifacts that became part of the aesthetic.

### Why Simulate PAL Composite?

1. **Historical Accuracy:** Most BBC Micros were connected to TVs, not monitors
2. **Artistic Intent:** Some games and demos were designed with composite artifacts in mind
3. **Nostalgia:** The "look" of composite PAL is part of the retro computing experience
4. **Educational:** Demonstrates the trade-offs of analog video encoding

## Current jsbeeb Architecture

### Video Pipeline

The video rendering system in jsbeeb consists of:

**Video Generation** (src/video.js:147-773)

- `Video` class generates pixels during CRTC emulation in `polltime()` method
- Renders to `Uint32Array` framebuffer (`fb32`) at 1024×625 resolution
- Uses 8-color palette (`collook`) mapped through `ulaPal` for ULA modes
- Handles teletext mode separately via SAA5050 emulation

**Display Output** (src/canvas.js)

- `Canvas` class: Uses 2D canvas context for software rendering
- `GlCanvas` class: Uses WebGL with simple passthrough shaders
  - Vertex shader: Maps quad to screen
  - Fragment shader: Samples texture directly
  - Texture upload via `texSubImage2D` (canvas.js:134-144)
- Both expose `paint(minx, miny, maxx, maxy)` method

**Key Insight:** jsbeeb already has WebGL infrastructure (`GlCanvas`), providing the foundation for GPU-accelerated PAL simulation without major architectural changes.

## Technical Background: PAL Composite Video

### BBC Micro PAL Encoding

Research into BBC Micro hardware documentation reveals the PAL encoding process:

**Color Subcarrier Generation**

- Crystal oscillator: 17.734475 MHz (X2, Q10 transistor)
- Divided by 4 using 74S74 bistable (IC46): **4.43361875 MHz**
- This is the PAL color subcarrier frequency

**Signal Processing Path**

1. Video ULA outputs RGB signals (0-7V range)
2. RGB → YUV conversion using resistor matrix
3. Quadrature modulation onto 4.43 MHz subcarrier:
   - U (B-Y) component: 90° phase
   - V (R-Y) component: 0° phase, **alternating polarity each line** (PAL)
4. Y (luminance) + modulated chrominance = composite signal

**Bandwidth Characteristics**

- Y (luminance): 5-6 MHz bandwidth
- U and V (chrominance): ~1.3 MHz bandwidth each
- This bandwidth mismatch is the source of color bleeding artifacts

**Chroma Amplitude Scaling**

The ITU-R BT.470 specification defines the mathematical YUV color space transformation, but it doesn't account for the physical voltage constraints of composite video transmission:

- PAL composite signals must stay within 0V (sync) to 1.0V (peak white)
- Luma occupies 0.3V (black) to 1.0V (white) - a 0.7V range
- Chroma is AC-coupled on top of this DC luma level

**The Problem:** Using raw ITU-R BT.470 YUV values causes overmodulation:

- Fully saturated colors produce chroma amplitudes up to 0.632 (for Red/Cyan)
- Blue (Y=0.114, chroma=0.447) would create composite values from -0.333 to 0.561 (goes negative!)
- Yellow (Y=0.886, chroma=0.447) would create composite values from 0.439 to 1.333 (exceeds 1.0V!)

**The Solution:** Chroma must be scaled down to prevent clipping:

- Theoretical maximum safe scaling: **0.255** (25.5% of signal range)
  - Limited by Blue's low Y value (lower bound constraint)
  - Limited by Yellow's high Y value (upper bound constraint)
- Practical implementations use **0.2** (20%) with a comfortable safety margin
- At 0.2 scaling: Maximum chroma amplitude is 0.126 (12.6% of full signal range)

This 20% chroma scaling is the origin of Thomas Harte's "Y×0.8 + chroma×0.2" formula - it prevents overmodulation while maintaining good color saturation. The scaling factor is an implementation detail for composite video encoding, separate from the theoretical YUV color space definition.

### PAL Decoding (in Television)

A PAL television reverses this process:

1. **Sync Separation:** Extract horizontal and vertical sync pulses
2. **Y/C Separation:** Comb filter separates luminance from chrominance
   - Simple notch filter: Removes 4.43 MHz from Y
   - Comb filter: Uses line delay to cancel chroma in Y signal
3. **Chroma Demodulation:**
   - Phase-locked loop (PLL) locks to color burst
   - Quadrature demodulation recovers U and V
   - PAL averaging: Combines alternating V phase lines to cancel errors
4. **YUV → RGB:** Matrix conversion back to RGB

### Artifacts to Simulate

Understanding the causes allows us to simulate them accurately:

1. **Dot Crawl**
   - **Cause:** Imperfect Y/C separation; chroma leaks into luma
   - **Appearance:** Moving checkerboard pattern along color transitions
   - **PAL-specific:** 6-line pattern (vs. NTSC's 3-line pattern)

2. **Color Bleeding**
   - **Cause:** Limited chroma bandwidth (~1.3 MHz)
   - **Appearance:** Colors smear horizontally into adjacent areas
   - **Effect:** Sharp color transitions become gradual

3. **Cross-Color (Rainbow Artifacts)**
   - **Cause:** High-frequency luma detail misinterpreted as chroma
   - **Appearance:** False colors on fine patterns (stripes, dithering)
   - **Examples:** Checkerboard patterns show color fringes

4. **Cross-Luminance**
   - **Cause:** Chroma signal residue in Y channel after filtering
   - **Appearance:** Brightness variations along color transitions
   - **Related to dot crawl:** Both from Y/C separation issues

5. **Hanover Bars (PAL-specific)**
   - **Cause:** Phase errors in V component on alternating lines
   - **Appearance:** Horizontal bars of incorrect hue
   - **Note:** Good comb filters eliminate this

## Implementation Options Analysis

### Option A: Adapt Blargg's NTSC Filter

**Description:** Port and modify existing blargg NTSC filter for PAL

**Technical Approach:**

- Pre-computed lookup tables for math-intensive calculations
- Runtime: 14-point RGB convolution per pixel (integer-only)
- Presets: Composite, S-Video, RGB quality levels

**Pros:**

- Battle-tested in many emulators (RetroArch, bsnes, etc.)
- Highly optimized: 740fps on 2.0 GHz Athlon (2005 CPU)
- LGPL licensed (compatible with jsbeeb)
- Minimal runtime cost: 8% CPU at 60fps on modest hardware

**Cons:**

- NTSC-specific (3.579545 MHz subcarrier vs. PAL 4.433618 MHz)
- No native PAL version available
- CPU-based (C code); would need WebGL port for GPU acceleration
- Different phase relationships (180° NTSC vs. PAL's alternating line)

**Verdict:** Good reference for optimization techniques, but significant adaptation needed for PAL

### Option B: svofski/CRT PAL Shader

**Description:** GLSL shader implementation of PAL modulation/demodulation

**Technical Approach:**

- True PAL composite signal simulation
- RGB → modulated composite → demodulated RGB
- Three shader variants:
  - `mpass`: Multi-pass (modulate → demodulate → recover)
  - `oversampling`: RGBA channel packing for bandwidth
  - `singlepass`: 4× subcarrier sampling, all in one pass

**Pros:**

- Designed specifically for PAL simulation
- GLSL shaders (directly usable in WebGL)
- Created for retro computing (originally for SDLMESS)
- Authentic dot crawl and color bleeding
- Singlepass variant: surprisingly efficient despite redundant calculations

**Cons:**

- May need adaptation for BBC Micro's specific characteristics
- Documentation is limited
- No performance benchmarks for web platform

**Verdict:** Best starting point for PAL-specific implementation

### Option C: Custom WebGL Shader

**Description:** Build PAL shader from scratch based on BBC Micro specs

**Technical Approach:**

1. RGB → YUV conversion
2. Generate composite waveform:
   ```
   C(t) = Y + U·sin(2πf·t) + V·cos(2πf·t)·PAL_phase(line)
   where f = 4.43361875 MHz
   ```
3. Simulate comb filter for Y/C separation
4. Demodulate U and V with bandwidth limiting
5. YUV → RGB conversion

**Pros:**

- Full control over implementation
- Tailored to BBC Micro hardware characteristics
- Can match specific ULA palette behavior
- Educational: understand every step

**Cons:**

- Significant development effort
- Needs validation against real hardware
- Risk of subtle bugs in signal processing math
- May not achieve blargg-level optimization without extensive tuning

**Verdict:** Good long-term goal, but higher risk for initial implementation

### Recommendation

**Hybrid Approach:**

1. Start with **Option B** (svofski/CRT) as foundation
2. Adapt for BBC Micro specifics (palette, timing)
3. Learn from **Option A** (blargg) for optimization techniques
4. Evolve toward **Option C** as understanding deepens

## Performance Optimization Strategies

### 1. GPU Acceleration (Primary Strategy)

**Why GPU?**

- Massively parallel: 640,000 pixels (1024×625) processed simultaneously
- Fragment shaders perfect for per-pixel filters
- jsbeeb already has WebGL infrastructure

**Best Practices:**

- Minimize texture bindings and state changes
- Cache `getUniformLocation()` calls
- Do work in vertex shader where possible (though most work is per-pixel)
- Use appropriate texture formats (RGBA8 sufficient)

**Shader Optimization:**

```glsl
// Good: Calculate once in vertex shader, interpolate
varying vec2 texelPosition;  // From vertex shader

// Bad: Calculate in fragment shader
vec2 texelPosition = gl_FragCoord.xy / resolution;
```

### 2. Quality Presets

Allow users to trade quality for performance:

| Preset        | Description                     | Performance              |
| ------------- | ------------------------------- | ------------------------ |
| **RGB**       | Bypass filter entirely          | Current speed (baseline) |
| **S-Video**   | Separate Y/C, minimal artifacts | +10% GPU cost            |
| **Composite** | Full PAL encode/decode          | +20-30% GPU cost         |
| **RF**        | Maximum degradation + noise     | +40% GPU cost            |

Implementation: Use shader conditionals or separate shader programs per preset.

### 3. OffscreenCanvas + WebWorker (Optional)

**Concept:** Offload rendering to worker thread using `OffscreenCanvas`

**Pros:**

- Frees main thread for emulation logic
- Canvas API available in worker context
- Transferable objects avoid copying

**Cons:**

- GPU contention: Main thread and worker both send GPU commands
- Adds architectural complexity
- Browser support (good in modern browsers, but not universal)
- Benefit unclear since GPU is bottleneck, not CPU

**Recommendation:** Start with main-thread WebGL; evaluate worker approach only if profiling shows main thread CPU bottleneck.

### 4. Adaptive Quality

**Dynamic adjustment based on performance:**

```javascript
if (frameTime > 16.67ms && currentQuality > MINIMUM) {
    currentQuality--;  // Drop to lower preset
} else if (frameTime < 14ms && currentQuality < userPreference) {
    currentQuality++;  // Restore quality
}
```

## Recommended Implementation Approach

### Phase 1: Foundation (WebGL PAL Shader)

**Goal:** Basic PAL simulation working end-to-end

**Tasks:**

1. **Create shader infrastructure** (1-2 days)
   - New directory: `src/video-filters/`
   - Files:
     - `pal-composite.js` - Filter manager class
     - `shaders/pal-encode.glsl` - Encoding fragment shader
     - `shaders/pal-decode.glsl` - Decoding fragment shader
   - Shader loading and compilation

2. **Implement PAL encoding shader** (2-3 days)

   ```glsl
   // Simplified algorithm
   vec3 rgb = texture2D(framebuffer, uv).rgb;
   vec3 yuv = rgb_to_yuv(rgb);

   float line = floor(uv.y * 625.0);
   float pal_phase = mod(line, 2.0) * 2.0 - 1.0;  // Alternates +1, -1

   float t = uv.x * horizontal_resolution / color_subcarrier_freq;
   float composite = yuv.y +
                     yuv.z * sin(2.0 * PI * t) +
                     yuv.x * cos(2.0 * PI * t) * pal_phase;
   ```

3. **Implement PAL decoding shader** (3-4 days)
   - Comb filter for Y/C separation (use line delay simulation)
   - Quadrature demodulation for U and V
   - Bandwidth limiting (low-pass filter on chroma)
   - YUV → RGB conversion

4. **Integrate into GlCanvas** (1-2 days)
   - Modify `src/canvas.js` to optionally use PAL filter
   - Add enable/disable toggle for A/B comparison
   - Handle texture ping-ponging if multi-pass needed

**Deliverable:** PAL filter that can be toggled on/off, showing visible artifacts

### Phase 2: Artifact Tuning and Calibration

**Goal:** Accurate BBC Micro-specific simulation

**Tasks:**

5. **Parameter exposure** (2-3 days)
   - User-adjustable shader uniforms:
     - `chromaBandwidth` (float, 1.0-2.0 MHz)
     - `dotCrawlIntensity` (float, 0.0-1.0)
     - `colorBleed` (float, 0.0-1.0)
     - `sharpness` (float, 0.0-1.0)
   - Preset system (composite/s-video/rgb)

6. **BBC Micro palette calibration** (2-3 days)
   - Test all video modes (MODE 0, 1, 2, 4, 5, 7)
   - Verify ULA color palette behavior through filter
   - Match color saturation to real hardware
   - Test teletext mode (SAA5050)

7. **Validation against reference** (2-3 days)
   - Collect reference photos/screenshots from real BBC Micro + TV
   - Side-by-side comparison
   - Adjust parameters to match
   - Community feedback

**Deliverable:** Convincing PAL simulation that matches real hardware

### Phase 3: Performance Optimization and Polish

**Goal:** Smooth 60fps performance, good UX

**Tasks:**

8. **Performance optimization** (2-3 days)
   - Shader profiling (use browser DevTools)
   - Reduce texture samples where possible
   - Optimize math (use built-in GLSL functions)
   - Benchmark on low-end hardware (integrated GPU)
   - Target: <2ms GPU time for filter

9. **UI integration** (2-3 days)
   - Settings panel for filter options
   - Live preview of changes
   - Save preferences to `localStorage`
   - Hotkey for quick toggle (e.g., Ctrl+T for TV mode)

10. **Code quality** (1-2 days)
    - Unit tests for color space conversions
    - Documentation (JSDoc)
    - Code review
    - Handle edge cases (WebGL not available, shader compilation failure)

**Deliverable:** Production-ready feature

### Phase 4: Optional Enhancements

**Goal:** Additional retro effects for enthusiasts

**Tasks:**

11. **CRT simulation** (optional, 1-2 days)
    - Scanline overlay
    - Phosphor mask (RGB triads)
    - Screen curvature
    - Corner vignetting

12. **Advanced artifacts** (optional, 2-3 days)
    - Phosphor persistence (temporal blur)
    - VHS tape effects:
      - Head switching noise
      - Dropout
      - Chroma noise
    - Analog noise (configurable level)

**Deliverable:** Full "retro TV" experience

## Detailed Technical Specifications

### Color Space Conversions

**RGB → YUV (ITU-R BT.470-2, PAL)**

```
Y =  0.299·R + 0.587·G + 0.114·B
U = -0.147·R - 0.289·G + 0.436·B  (B-Y scaled)
V =  0.615·R - 0.515·G - 0.100·B  (R-Y scaled)
```

**YUV → RGB**

```
R = Y + 1.140·V
G = Y - 0.394·U - 0.581·V
B = Y + 2.028·U
```

### PAL Encoding

**Composite Signal:**

```
C(x,y,t) = Y(x,y) + CHROMA_GAIN · [U(x,y)·sin(ωt) + V(x,y)·cos(ωt)·P(y)]

where:
  ω = 2π × 4.43361875 MHz
  P(y) = (-1)^y  (alternates each scanline, also called v_switch)
  CHROMA_GAIN = 0.2  (prevents overmodulation, see "Chroma Amplitude Scaling" above)
  x = horizontal position
  y = scanline number
  t = time (related to x)
```

**Note:** The CHROMA_GAIN factor (0.2) scales the chroma to prevent the composite signal from exceeding the valid voltage range (0-1V). Without this scaling, fully saturated colors would cause the signal to clip. This is distinct from the ITU-R BT.470 YUV conversion coefficients, which are already included in the U and V values.

**Horizontal Sampling:**
To properly capture the 4.43 MHz subcarrier:

- Nyquist theorem: Sample at ≥2× subcarrier = 8.867 MHz minimum
- Recommendation: 4× oversampling = 17.734 MHz (matches BBC Micro crystal!)
- At 1024 horizontal pixels: Effective sample rate ~16 MHz (adequate)

### PAL Decoding

**Comb Filter (2-line):**

```
Y(x,y) = [C(x,y) + C(x,y-1)] / 2
Chroma(x,y) = [C(x,y) - C(x,y-1)] / 2
```

This exploits PAL's alternating phase: chroma cancels in sum, luma cancels in difference.

**Demodulation:**

```
U(x,y,t) = Chroma(x,y,t) · sin(ωt) · 2  (lowpass filtered)
V(x,y,t) = Chroma(x,y,t) · cos(ωt) · 2 / P(y)  (lowpass filtered)
```

**Bandwidth Limiting:**

- Y: Low-pass at 5.5 MHz (or full bandwidth for sharp mode)
- U, V: Low-pass at 1.3 MHz (simulates chroma bandwidth limit)

Implement as Gaussian blur in shader (approximate low-pass filter).

## Proposed Code Structure

```
src/
  video-filters/
    pal-composite.js           # Main PAL filter class
    shaders/
      pal-common.glsl          # Shared functions (color space conversion)
      pal-encode.frag          # Encoding fragment shader
      pal-decode.frag          # Decoding fragment shader
      pal-singlepass.frag      # Combined encode/decode (optimized)
      passthrough.vert         # Simple vertex shader
  canvas.js                    # Modify GlCanvas to use filter
  config.js                    # Add PAL filter settings
  main.js                      # Wire up UI controls

tests/
  unit/
    test-pal-composite.js      # Unit tests for color conversions
  integration/
    pal-visual.js              # Visual regression tests

docs/
  pal-simulation-design.md     # This document
  pal-shader-reference.md      # Shader implementation details (future)
```

### Example API

```javascript
// In src/video-filters/pal-composite.js
export class PALCompositeFilter {
  constructor(gl) {
    this.gl = gl;
    this.enabled = false;
    this.quality = "composite"; // 'rgb', 'svideo', 'composite', 'rf'
    this.params = {
      chromaBandwidth: 1.3, // MHz
      dotCrawl: 0.7, // 0.0 - 1.0
      colorBleed: 0.8, // 0.0 - 1.0
      sharpness: 0.5, // 0.0 - 1.0
    };
    this._compileShaders();
    this._createTextures();
  }

  apply(sourceTexture, destFramebuffer) {
    if (!this.enabled) {
      // Passthrough
      this._blit(sourceTexture, destFramebuffer);
      return;
    }

    // Apply PAL filter
    this._renderWithShader(sourceTexture, destFramebuffer);
  }

  setQuality(quality) {
    this.quality = quality;
    this._updateShaderUniforms();
  }

  // ... implementation
}
```

## Performance Budget

**Target:** 60fps (16.67ms total frame budget) at 1024×625 resolution

**Current Baseline** (from jsbeeb profiling):

- Emulation logic: ~10-12ms (varies with content)
- Video rendering: ~1-2ms (WebGL upload + blit)
- Total: ~12-14ms (leaving 2-4ms headroom)

**Estimated PAL Filter Cost:**

- Fragment shader executions: 1024 × 625 = 640,000 pixels
- Operations per pixel:
  - RGB→YUV: ~10 ops
  - Subcarrier sampling (4×): ~20 ops × 4 = 80 ops
  - Comb filter (line delay): ~5 ops
  - Demodulation: ~30 ops
  - YUV→RGB: ~10 ops
  - Total: ~135 ops/pixel
- Modern GPU (2015+): 100+ Gpixels/s throughput
- Estimated time: 640,000 × 135 / 100G ≈ **0.8-1.5ms**

**Validation:**

- blargg's CPU filter: 1.35ms on 2005-era CPU (740fps)
- Modern GPU with parallelism should achieve similar or better
- Leaves 12-14ms for emulation (unchanged from current)

**Acceptable Range:**

- Excellent: <1ms (could support higher resolution or more effects)
- Good: 1-2ms (meets 60fps target with headroom)
- Acceptable: 2-4ms (60fps with reduced headroom)
- Needs optimization: >4ms (may drop frames)

## Risk Assessment and Mitigation

### Risk 1: Insufficient Performance

**Likelihood:** Low
**Impact:** High (unusable feature)

**Mitigation:**

- Early performance prototyping
- Quality presets allow users to reduce cost
- Fallback to RGB mode if GPU too slow
- Progressive enhancement (start simple, add complexity)

### Risk 2: Inaccurate Simulation

**Likelihood:** Medium
**Impact:** Medium (poor user experience, but functional)

**Mitigation:**

- Reference real hardware screenshots
- Community validation (BBC Micro enthusiasts)
- Tunable parameters for calibration
- Document known limitations

### Risk 3: Browser/GPU Compatibility

**Likelihood:** Low-Medium
**Impact:** Medium (feature unavailable on some systems)

**Mitigation:**

- Require only WebGL 1.0 (widely supported since 2011)
- Graceful degradation to current RGB rendering
- Feature detection and user notification
- Test on multiple browsers (Chrome, Firefox, Safari, Edge)

### Risk 4: Development Complexity

**Likelihood:** Medium
**Impact:** Low (delayed timeline, but not critical path)

**Mitigation:**

- Leverage existing work (svofski/CRT as reference)
- Incremental implementation with testable milestones
- Phase-based approach allows early wins
- Focus on "good enough" before "perfect"

### Risk 5: Maintenance Burden

**Likelihood:** Low
**Impact:** Low (technical debt)

**Mitigation:**

- Well-documented code (JSDoc, inline comments)
- Unit tests for color conversion math
- Separate module (can be disabled/removed if needed)
- Follows jsbeeb coding conventions

## Testing Strategy

### Unit Tests

- Color space conversions (RGB↔YUV)
  - Test known values
  - Round-trip accuracy
- PAL phase calculation
- Comb filter math

### Integration Tests

- WebGL shader compilation
- Texture upload/download
- Framebuffer operations
- Parameter changes

### Visual Regression Tests

- Reference images for each video mode
- Screenshot comparison (allow some tolerance for GPU differences)
- Artifact presence verification (dot crawl visible, etc.)

### Performance Tests

- Frame time measurement
- GPU profiler integration
- Benchmark on target hardware

### User Testing

- Beta test with BBC Micro community
- Gather feedback on authenticity
- Usability of controls

## Success Criteria

### Minimum Viable Product (MVP)

- [ ] PAL filter can be enabled/disabled
- [ ] Visible dot crawl on color transitions
- [ ] Color bleeding on sharp edges
- [ ] Runs at 60fps on modern hardware (2015+)
- [ ] Works in Chrome, Firefox, Safari

### Full Success

- [ ] All video modes look correct (MODE 0-7)
- [ ] User-adjustable parameters
- [ ] Multiple quality presets
- [ ] Community validation: "looks like my old Beeb!"
- [ ] <2ms GPU time for filter
- [ ] Comprehensive documentation

### Stretch Goals

- [ ] CRT effects (scanlines, curvature)
- [ ] VHS tape artifacts
- [ ] Save/load filter presets
- [ ] Share settings via URL parameters

## Timeline Estimate

### Phase 1: Foundation

- Shader infrastructure: 1-2 days
- Encoding shader: 2-3 days
- Decoding shader: 3-4 days
- GlCanvas integration: 1-2 days
- **Total: 7-11 days (1.5-2 weeks)**

### Phase 2: Tuning

- Parameter exposure: 2-3 days
- Calibration: 2-3 days
- Validation: 2-3 days
- **Total: 6-9 days (1-2 weeks)**

### Phase 3: Polish

- Optimization: 2-3 days
- UI: 2-3 days
- Code quality: 1-2 days
- **Total: 5-8 days (1 week)**

### Phase 4: Optional

- CRT effects: 1-2 days
- Advanced artifacts: 2-3 days
- **Total: 3-5 days (optional)**

**Overall: 4-6 weeks for full implementation (Phases 1-3)**

## References and Resources

### Academic/Technical

- ITU-R BT.470-2: PAL television standard
- ITU-R BT.601: Digital YUV color space
- "Reduction of Dot Crawl and Rainbow Artifacts in the NTSC Video" (IEEE)

### Open Source Projects

- **svofski/CRT**: https://github.com/svofski/CRT
  - PAL modulation/demodulation in GLSL
  - Reference for shader implementation
- **blargg's NTSC filter**: https://www.slack.net/~ant/libs/ntsc.html
  - Optimization techniques
  - Lookup table approach
- **RetroArch**: https://github.com/libretro/RetroArch
  - NTSC filter integration examples
  - Shader preset system
- **zhuker/ntsc**: https://github.com/zhuker/ntsc
  - Python composite video simulator
  - Artifact reference

### BBC Micro Hardware

- **BBC Hardware Guide**: http://bbc.nvg.org/doc/A%20Hardware%20Guide%20for%20the%20BBC%20Microcomputer/
  - PAL encoder circuit description (Chapter 3)
  - Color subcarrier generation
- **BeebWiki Video ULA**: https://beebwiki.mdfs.net/Video_ULA
  - Palette and RGB output details
- **The BBC Transform PAL Decoder**: https://www.jim-easterbrook.me.uk/pal/
  - PAL decoding algorithms (attempted retrieval, may have access issues)

### WebGL Resources

- **WebGL Fundamentals**: https://webglfundamentals.org/
  - Shader tutorials
  - Best practices
- **OffscreenCanvas Guide**: https://web.dev/articles/offscreen-canvas
  - Worker integration
  - Performance considerations
- **WebGL Best Practices (MDN)**: https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices
  - Optimization techniques

## Appendix A: Glossary

- **Composite Video**: Analog video signal combining luminance and chrominance
- **Chroma**: Color information (U and V components)
- **Chrominance**: See Chroma
- **Comb Filter**: Filter using line delay to separate Y and C
- **Cross-Color**: Luma detail misinterpreted as chroma (rainbow artifacts)
- **Cross-Luminance**: Chroma residue in luma signal (dot crawl)
- **Dot Crawl**: Checkerboard artifacts from Y/C crosstalk
- **Luminance**: Brightness information (Y component)
- **PAL**: Phase Alternating Line (625-line, 50Hz, 4.43MHz subcarrier)
- **Quadrature Modulation**: 90° phase offset modulation for U and V
- **Subcarrier**: High-frequency carrier for chroma (4.43 MHz in PAL)
- **ULA**: Uncommitted Logic Array (BBC Micro video chip)
- **YUV**: Color space separating luma (Y) from chroma (U, V)

## Appendix B: FAQ

**Q: Will this slow down the emulator?**
A: Target is <2ms GPU time, leaving the CPU free for emulation. Modern GPUs should handle this easily.

**Q: Can I turn it off?**
A: Yes, there will be an RGB mode that bypasses the filter entirely (current behavior).

**Q: Will it work on my device?**
A: Requires WebGL 1.0 support (available since ~2011). Most devices made after 2013 should work fine.

**Q: What about NTSC?**
A: This design focuses on PAL (BBC Micro was PAL-only in UK). NTSC support could be added later using similar techniques.

**Q: How accurate will it be?**
A: Goal is "convincing" not "bit-perfect". Real hardware varies (TV quality, tuning, etc.), so we aim for the general aesthetic.

**Q: Can I customize the look?**
A: Yes, adjustable parameters for dot crawl intensity, color bleed, sharpness, etc.

**Q: Will this help me win at Elite?**
A: No, but it might make you nostalgic enough to try. 🚀

## Appendix C: Alternative Approaches Considered

### Lookup Table (LUT) Approach

Similar to blargg's method: pre-compute all possible combinations.

**Pros:** Very fast runtime
**Cons:** Large memory footprint, doesn't leverage GPU parallelism, inflexible

**Rejected:** WebGL shader approach better suited to web platform

### Post-Processing Filter (After Render)

Apply filter as separate pass after emulation renders.

**Pros:** Clean separation of concerns
**Cons:** Extra texture copy, cache miss, already doing this!

**Accepted:** This is the recommended approach (described in main document)

### Real-Time Analog Circuit Simulation

Model every component of PAL encoder/decoder circuit.

**Pros:** Ultimate accuracy
**Cons:** Extreme computational cost, overkill for visual emulation

**Rejected:** Simplified signal processing model sufficient

## Appendix D: Future Enhancements

Ideas for future development beyond initial implementation:

1. **PAL-I vs PAL-B/G/D/K Variants**
   - Different countries used slight PAL variations
   - Could offer regional presets

2. **Automatic Calibration**
   - Machine learning to match reference photos
   - User uploads TV photo, system tunes parameters

3. **"Mistuned TV" Mode**
   - Simulate slightly off-tune receiver
   - Color balance shifts, weak sync

4. **Temporal Effects**
   - Frame blending (phosphor persistence)
   - Motion-dependent artifacts

5. **Multiple Display Profiles**
   - "High-end RGB monitor" (current)
   - "Average TV" (default PAL simulation)
   - "Portable TV" (extra noise, poor tuning)
   - "VHS recording" (tape artifacts)

6. **Interactive Calibration Tool**
   - Side-by-side comparison with reference
   - Slider adjustments with live preview
   - Save custom presets

7. **Performance Dashboard**
   - Real-time display of frame time breakdown
   - GPU/CPU usage
   - Help identify bottlenecks

---

**End of Design Document**

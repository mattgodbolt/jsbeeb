# Authentic PAL TV Comb Filter Research

## Sources

1. **Watkinson "Engineer's Guide to Decoding & Encoding"** (pages 37-39)
2. **Jim Easterbrook PAL Decoder Page** (https://www.jim-easterbrook.me.uk/pal/)
3. **Web search**: PAL television patents and implementations from 1980s

## What Real PAL TVs Used

### 2H Delay Line Comb Filters

**Implementation:**

- Used "64 microsecond quartz delay line" (2 line periods for PAL)
- Delays of **2H** (two horizontal line periods) for PAL
- Contrast with NTSC which uses 1H delays

**Why 2H for PAL?**

- PAL subcarrier: 283.75 cycles per line (fractional 0.75)
- 2H spacing = 1.5 cycles = 540° = **180° phase shift** (mod 360°)
- This ensures chroma signals are in opposite phase and cancel when added
- V-switch state is SAME on lines N and N±2 (both inverted or both non-inverted)

**From Watkinson (page 38):**

> "The delays needed are of one line period [for NTSC]. The configuration for PAL is shown in b) in which the delays need to be of two line periods."

### Complementary Decoder Approach

**From Jim Easterbrook:**

> "Some form of filter is used to extract the modulated chrominance from a PAL signal. Subtracting this chrominance from a suitably delayed PAL signal then yields luminance"

This is the **complementary decoder** principle:

1. Extract chroma from composite using a filter
2. Subtract extracted chroma from **delayed** composite to get luma
3. The decoder is "complementary" because chroma + luma = original PAL signal

**Important Note:**

> "Decoders like this are not widely used, as better subjective results can be obtained by using separate filters for chrominance and luminance, each optimised to give the best looking signals."

**This explains our findings!**

- Notch filter (complementary approach) is simpler but not what most TVs used
- Real TVs used separate optimized filters for chroma and luma

### Simple Line Comb for Luma (Most Common Approach)

**From Watkinson Figure 3.4.2b:**

- PAL comb uses 2H delays
- **Simple averaging:** Add current line + line delayed by 2H
- This is a LOWPASS filter for luma
- Chroma cancels due to 180° phase inversion
- Luma adds (in phase)

**Coefficients:**

- Simplest form: `luma = 0.5 * current + 0.5 * delayed_2H`
- 3-tap variation: `luma = 0.25 * prev_2H + 0.5 * current + 0.25 * next_2H`

### Tradeoffs and Limitations

**From Watkinson (page 38-39):**

> "Quite a lot of vertical luminance resolution is being lost, and becoming cross luminance, particularly in PAL."

**The fundamental tradeoff:**

- **More averaging** (comb filter) → Less cross-color, more vertical blur
- **Less averaging** (notch filter) → Sharper, but more cross-color/cross-luma artifacts

**Bandpass Comb Variation:**

> "Some of this resolution loss can be overcome by restricting the combing to a bandpass region"

This means applying the comb filter only to mid-frequencies where chroma lives, preserving low-frequency luma detail. However:

> "Although the full luminance bandwidth is available, this is restricted to picture detail having vertical edges. Man-made subjects such as buildings give good results, but more natural scenes containing diagonal edges are less successful."

### BBC Transform Decoder (Advanced)

**Not a comb filter!** Uses Fourier transforms:

> "Each frequency in the block is compared with its reflection about the colour sub-carrier frequency, and if the magnitudes are too dissimilar the pair of frequencies is rejected."

This is much more sophisticated than simple comb filters and not what consumer TVs used.

## Summary for Implementation

### What Consumer PAL TVs Actually Did:

1. **Most common:** Simple 2H comb filter for luma
   - Average current line with line ±2H away
   - Coefficients: 0.5 + 0.5 (or 0.25 + 0.5 + 0.25 for 3-tap)
   - Accept vertical blur as tradeoff for reduced color artifacts

2. **Some higher-end:** Separate optimized filters
   - Not pure complementary decoder
   - Custom filters for chroma and luma
   - Try to balance sharpness vs artifacts

3. **Not common:** Pure notch/complementary decoders
   - Simpler but gave worse subjective results
   - Used in some early/cheap implementations

### What We Should Simulate:

**Option 1: Authentic simple comb (most TVs)**

- Use 2H comb with equal weighting: `luma = 0.5 * current + 0.5 * delayed_2H`
- Accept some vertical blur (that's what real TVs had!)
- Minimal checkerboard/cross-color

**Option 2: Notch filter (current implementation)**

- Sharper than real TVs
- But with FIR_GAIN = 2.0, no checkerboard
- Arguably "better" than real hardware, but less authentic

**Recommendation:**
Implement the simple 2H comb as an option so users can choose between:

- "Sharp mode" (notch filter - better than real hardware)
- "Authentic mode" (2H comb - what TVs actually did, with appropriate blur)

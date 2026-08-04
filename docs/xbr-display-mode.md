# The xBR display mode

`Smoothed (xBR)` runs [xBR-lv2](https://forums.libretro.com/t/xbr-algorithm-tutorial/123),
Hyllian's edge-directed pixel-art upscaler, so diagonals are drawn as smooth
lines rather than staircases. Select it from the display menu or with
`?displayMode=xbr`.

This note covers the part that is specific to jsbeeb. The algorithm itself is a
port of a published shader, and `src/video-filters/shaders/xbr.frag.glsl`
carries its own commentary.

## The logical pixel grid

jsbeeb's framebuffer is a 1024-wide **raster**, not a grid of BBC pixels. One
logical pixel covers several framebuffer texels:

- horizontally, `Video.blitFb` writes `pixelsPerChar` texels per byte, so a
  logical pixel is one texel wide in MODE 0, two in MODE 1, and four in MODE 2
  and MODE 5;
- vertically, non-interlaced modes write each CRTC scanline into two adjacent
  rows.

An upscaler that samples raw texel neighbours therefore finds nine copies of the
same pixel in its 3x3 neighbourhood, decides there is no edge anywhere, and
leaves the picture as it found it. That is not hypothetical — it is why
[#667](https://github.com/mattgodbolt/jsbeeb/pull/667), an earlier attempt at
this feature, produced no visible difference at all.

Only the video chips know the grid, and it changes during a frame, so each
records one descriptor byte per framebuffer row in `Video.lineGrid`:

| bits | meaning                                     |
| ---- | ------------------------------------------- |
| 0-2  | the pixel's width in texels, less one       |
| 3    | set if the scanline was written to two rows |
| 7    | set if the row was rendered at all          |

Width is stored less one so it needs no logarithm to write and no exponential to
read, and so any width from one to eight fits — the Atom's 6847 uses widths the
BBC's ULA never selects, and records the same descriptor from its own blitters.
MODE 7 counts as one texel per pixel: the SAA5050 emulation writes each of its
16 texels per character individually, so its output is already at the
framebuffer's own resolution.

`src/video-filters/pixel-grid.js` owns the encoding. The filter uploads
`lineGrid` as a one-pixel-wide texture each frame, and the shader reads it to
decide what a "pixel" means on the row it is drawing.

Two limits worth knowing:

- **A row records only the last mode on it.** Enough for a raster split, which
  is what people write; not enough for one that changes part way along a line.
- **The shader has no bands.** It reads each row's descriptor and samples its
  vertical neighbours at that row's stride, so at a mode change it reads the
  neighbouring mode's texels at the wrong one. Expect a row or two of artefact
  at a seam.

## Keeping the shader honest

Node has no WebGL, so the GLSL cannot be unit tested in the usual way. Instead
`src/video-filters/xbr.js` is a literal JavaScript port of the same algorithm,
which the unit tests exercise directly, and `tools/verify-xbr-shader.js`
captures frames from a real emulated machine, renders them through the real
shader in headless Chrome, and compares the two pixel by pixel.

Be precise about what that establishes. It catches the two implementations
drifting apart, which is what makes it safe to optimise one of them — the
shader's flat-region early return is deliberately absent from the JavaScript, so
the comparison is what proves it changes nothing. It does **not** establish that
either matches upstream xBR-lv2; only reading the slang source does that.

CI runs this on every push, so the two cannot drift apart unnoticed — which is
the only thing that makes keeping a second implementation reasonable. To run it
yourself:

```sh
npm run verify-shader
```

It is deliberately not called `test:something`: `npm test` globs `test:*`, and
this is the one check that needs a browser. It declines to compare frames
containing more than one mode, for the band reason above, and says so rather
than passing quietly.

## What it suits

- **Graphics modes** are what it is for — diagonals and curves become
  continuous.
- **MODE 0** is barely touched. One texel per pixel and 640 across leaves little
  to reconstruct, and text stays crisp.
- **Chunky text in MODE 2 and MODE 5** is where opinions differ; characters are
  eight logical pixels wide and get noticeably rounded.
- **MODE 7** is left alone — the SAA5050's own character rounding got there
  first.

The mode draws into as many pixels as the display will show, up to twice the
usual canvas (`maxCanvasScale`). Rendering more than the display can show costs
fragments and buys nothing, and this shader is expensive per fragment.

## Attribution

xBR-lv2 is from `edge-smoothing/xbr/shaders/xbr-lv2-standalone.slang` in
libretro's slang-shaders, Copyright (C) 2011-2022 Hyllian
\<sergiogdb@gmail.com\>, MIT licensed, incorporating ideas from Joshua Street's
SABR shader. The notice is kept in both `xbr.js` and `xbr.frag.glsl`.

Note the older `xbr/shaders/xbr-lv2.glsl` in libretro's **glsl**-shaders
repository declares `f4` and never assigns it, so it reads an uninitialised
`vec4`. Use the standalone slang version as the reference, not that one.

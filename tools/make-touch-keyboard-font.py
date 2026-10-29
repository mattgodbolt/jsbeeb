"""Builds public/fonts/open-gorton/OpenGorton-Regular.woff2 for the on-screen keyboard's legends.

Takes OpenGorton-Regular.otf from https://github.com/dakotafelder/open-gorton and:
- keeps only printable ASCII less the lowercase letters, which the font maps to its capitals; the keyboard's one
  lowercase legend, the italic f of the function keys, falls back to a font that has a real one
- slashes the zero, as the BBC Micro's keycaps do

Needs fontTools with WOFF2 support (`pip install 'fonttools[woff]'`):
    python3 tools/make-touch-keyboard-font.py path/to/OpenGorton-Regular.otf
"""

import math
import sys
from pathlib import Path

from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

Output = Path(__file__).resolve().parent.parent / "public" / "fonts" / "open-gorton" / "OpenGorton-Regular.woff2"
KeptCodepoints = [c for c in range(0x20, 0x7F) if not ord("a") <= c <= ord("z")]
# Matches the font's own stroke: the stem of its I is 71 units wide.
StrokeWidth = 71


def slash_zero(font):
    glyph_set = font.getGlyphSet()
    zero = glyph_set["zero"]
    recording = RecordingPen()
    zero.draw(recording)
    pen = T2CharStringPen(zero.width, glyph_set)
    recording.replay(pen)

    # Each end sits on the middle of the ring's stroke, so its square end is hidden in the ring.
    xmin, ymin, xmax, ymax = 35, -1, 592, 702
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    rx, ry = (xmax - xmin - StrokeWidth) / 2, (ymax - ymin - StrokeWidth) / 2
    dx, dy = rx / math.sqrt(2), ry / math.sqrt(2)
    length = math.hypot(dx, dy)
    nx, ny = -dy / length * StrokeWidth / 2, dx / length * StrokeWidth / 2
    # Anticlockwise like the ring's outside, so the slash fills where it crosses the ring rather than cutting it.
    corners = [
        (cx - dx - nx, cy - dy - ny),
        (cx + dx - nx, cy + dy - ny),
        (cx + dx + nx, cy + dy + ny),
        (cx - dx + nx, cy - dy + ny),
    ]
    pen.moveTo(tuple(round(v) for v in corners[0]))
    for corner in corners[1:]:
        pen.lineTo(tuple(round(v) for v in corner))
    pen.closePath()

    cff = font["CFF "].cff
    top = cff.topDictIndex[0]
    charstring = pen.getCharString(private=top.Private, globalSubrs=cff.GlobalSubrs)
    top.CharStrings["zero"] = charstring


def main(source):
    # Keeps the source's own date, so the same source always builds the same file.
    font = TTFont(source, recalcTimestamp=False)
    options = Options()
    options.flavor = "woff2"
    options.layout_features = []
    options.desubroutinize = True
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=KeptCodepoints)
    subsetter.subset(font)
    slash_zero(font)
    font.flavor = "woff2"
    Output.parent.mkdir(parents=True, exist_ok=True)
    font.save(Output)
    print(f"Wrote {Output} ({Output.stat().st_size} bytes)")


if __name__ == "__main__":
    main(sys.argv[1])

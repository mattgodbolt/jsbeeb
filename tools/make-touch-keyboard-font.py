"""Builds public/fonts/open-gorton/OpenGorton-Regular.woff2 for the on-screen keyboard's legends.

Takes OpenGorton-Regular.otf from https://github.com/dakotafelder/open-gorton and:
- keeps only printable ASCII less the lowercase letters, which the font maps to its capitals; the keyboard's one
  lowercase legend, the italic f of the function keys, is drawn instead
- makes the zero a slashed O, as the BBC Micro's keycaps print it

Needs fontTools with WOFF2 support (`pip install 'fonttools[woff]'`):
    python3 tools/make-touch-keyboard-font.py path/to/OpenGorton-Regular.otf
"""

import math
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

Output = Path(__file__).resolve().parent.parent / "public" / "fonts" / "open-gorton" / "OpenGorton-Regular.woff2"
KeptCodepoints = [c for c in range(0x20, 0x7F) if not ord("a") <= c <= ord("z")]
# The keycaps' zero is the round O, slashed at about 45 degrees from corner to corner, its ends a quarter of the
# radius past the ring.
SlashAngle = 45
SlashReach = 1.25
Kappa = 0.5523


def bounds(glyph_set, name):
    pen = BoundsPen(glyph_set)
    glyph_set[name].draw(pen)
    return pen.bounds


def slash_zero(font):
    glyph_set = font.getGlyphSet()
    stem_xmin, _, stem_xmax, _ = bounds(glyph_set, "I")
    half_width = (stem_xmax - stem_xmin) / 2
    letter_o = glyph_set["O"]
    recording = RecordingPen()
    letter_o.draw(recording)
    pen = T2CharStringPen(letter_o.width, glyph_set)
    recording.replay(pen)

    xmin, ymin, xmax, ymax = bounds(glyph_set, "O")
    cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
    reach = SlashReach * (xmax - xmin) / 2 - half_width
    ux, uy = math.cos(math.radians(SlashAngle)), math.sin(math.radians(SlashAngle))
    nx, ny = -uy * half_width, ux * half_width
    tx, ty = ux * half_width, uy * half_width
    start_x, start_y = cx - ux * reach, cy - uy * reach
    end_x, end_y = cx + ux * reach, cy + uy * reach

    def point(x, y):
        return round(x), round(y)

    def round_cap(x, y, sign):
        # A half circle from the stroke's right edge to its left, as two quarter-circle curves.
        k = Kappa
        pen.curveTo(
            point(x - nx + sign * tx * k, y - ny + sign * ty * k),
            point(x + sign * tx - nx * k, y + sign * ty - ny * k),
            point(x + sign * tx, y + sign * ty),
        )
        pen.curveTo(
            point(x + sign * tx + nx * k, y + sign * ty + ny * k),
            point(x + nx + sign * tx * k, y + ny + sign * ty * k),
            point(x + nx, y + ny),
        )

    # Anticlockwise like the ring's outside, so the slash fills where it crosses the ring rather than cutting it.
    pen.moveTo(point(start_x - nx, start_y - ny))
    pen.lineTo(point(end_x - nx, end_y - ny))
    round_cap(end_x, end_y, 1)
    pen.lineTo(point(start_x + nx, start_y + ny))
    nx, ny = -nx, -ny
    round_cap(start_x, start_y, -1)
    pen.closePath()

    cff = font["CFF "].cff
    top = cff.topDictIndex[0]
    top.CharStrings["zero"] = pen.getCharString(private=top.Private, globalSubrs=cff.GlobalSubrs)
    font["hmtx"]["zero"] = font["hmtx"]["O"]


def main(source):
    # Keeps the source's own date, so the same source always builds the same file.
    font = TTFont(source, recalcTimestamp=False)
    options = Options()
    options.layout_features = []
    options.desubroutinize = True
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=KeptCodepoints)
    subsetter.subset(font)
    slash_zero(font)
    font.flavor = "woff2"
    font.save(Output)
    print(f"Wrote {Output} ({Output.stat().st_size} bytes)")


if __name__ == "__main__":
    main(sys.argv[1])

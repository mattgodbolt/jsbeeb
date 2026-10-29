"""Builds public/fonts/open-gorton/OpenGorton-Regular.woff2 for the on-screen keyboard's legends.

Takes OpenGorton-Regular.otf from https://github.com/dakotafelder/open-gorton and:
- keeps only printable ASCII less the lowercase letters, which the font maps to its capitals
- makes the zero a slashed O, as the BBC Micro's keycaps print it
- adds the function keys' f at U+0066 and the cursor keys' arrows at U+2190 to U+2193, drawn as the keycaps print them

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
Kappa = 0.5523
# The keycaps' zero is the round O, slashed at about 45 degrees from corner to corner, its ends a quarter of the
# radius past the ring.
SlashAngle = 45
SlashReach = 1.25

# The function keys' f: a plain f leaning 10 degrees, standing on the baseline, 850 units tall with a stroke of 86
# (a little heavier than Gorton's 71, as on the caps). Drawn in a box FBoxHeight high, y down, baseline at its foot.
FBoxHeight = 700
FScale = 850 / FBoxHeight
FStrokeWidth = 86
FAdvance = 376
FHook = ((490, 110), (470, 25), (372, 20), (360, 110))
FStemFoot = (262, 665)
FCrossbar = ((232, 270), (432, 270))
FBoxLeft = 200
HookSegments = 12

# The cursor keys' arrow: a solid head over half its length and a thin shaft, 1100 units long and 550 across,
# centred on the capitals' middle. Drawn pointing left in an ArrowBox, y down.
ArrowBox = (20, 10)
ArrowLength = 1100
ArrowScale = ArrowLength / ArrowBox[0]
ArrowWidth = round(ArrowBox[1] * ArrowScale)
ArrowMiddle = 350
ArrowOutline = ((0, 5), (11, 0), (11, 4.1), (20, 4.1), (20, 5.9), (11, 5.9), (11, 10))
Arrows = {0x2190: (-1, 0), 0x2191: (0, 1), 0x2192: (1, 0), 0x2193: (0, -1)}


def bounds(glyph_set, name):
    pen = BoundsPen(glyph_set)
    glyph_set[name].draw(pen)
    return pen.bounds


def point(x, y):
    return round(x), round(y)


def capsule(pen, start, end, half_width):
    """A straight stroke with round ends, anticlockwise so that it fills where it overlaps other outlines."""
    (sx, sy), (ex, ey) = start, end
    length = math.hypot(ex - sx, ey - sy)
    ux, uy = (ex - sx) / length, (ey - sy) / length
    tx, ty = ux * half_width, uy * half_width
    nx, ny = -uy * half_width, ux * half_width
    k = Kappa
    pen.moveTo(point(sx - nx, sy - ny))
    pen.lineTo(point(ex - nx, ey - ny))
    pen.curveTo(point(ex - nx + tx * k, ey - ny + ty * k), point(ex + tx - nx * k, ey + ty - ny * k), point(ex + tx, ey + ty))
    pen.curveTo(point(ex + tx + nx * k, ey + ty + ny * k), point(ex + nx + tx * k, ey + ny + ty * k), point(ex + nx, ey + ny))
    pen.lineTo(point(sx + nx, sy + ny))
    pen.curveTo(point(sx + nx - tx * k, sy + ny - ty * k), point(sx - tx + nx * k, sy - ty + ny * k), point(sx - tx, sy - ty))
    pen.curveTo(point(sx - tx - nx * k, sy - ty - ny * k), point(sx - nx - tx * k, sy - ny - ty * k), point(sx - nx, sy - ny))
    pen.closePath()


def charstring(font, pen):
    cff = font["CFF "].cff
    top = cff.topDictIndex[0]
    return pen.getCharString(private=top.Private, globalSubrs=cff.GlobalSubrs)


def add_glyph(font, name, pen, advance, codepoint):
    top = font["CFF "].cff.topDictIndex[0]
    char_strings = top.CharStrings
    drawn = charstring(font, pen)
    if char_strings.charStringsAreIndexed:
        char_strings.charStrings[name] = len(char_strings.charStringsIndex)
        char_strings.charStringsIndex.append(drawn)
    else:
        char_strings.charStrings[name] = drawn
    top.charset.append(name)
    font.setGlyphOrder([*font.getGlyphOrder(), name])
    font["hmtx"][name] = (advance, round(drawn.calcBounds(char_strings)[0]))
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[codepoint] = name


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
    capsule(pen, (cx - ux * reach, cy - uy * reach), (cx + ux * reach, cy + uy * reach), half_width)

    font["CFF "].cff.topDictIndex[0].CharStrings["zero"] = charstring(font, pen)
    font["hmtx"]["zero"] = font["hmtx"]["O"]


def add_f(font):
    def to_font(x, y):
        return (x - FBoxLeft) * FScale, (FBoxHeight - y) * FScale

    pen = T2CharStringPen(FAdvance, font.getGlyphSet())
    half_width = FStrokeWidth / 2
    p0, p1, p2, p3 = (to_font(*p) for p in FHook)
    previous = p0
    for step in range(1, HookSegments + 1):
        t = step / HookSegments
        current = tuple(
            (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t**2 * c + t**3 * d
            for a, b, c, d in zip(p0, p1, p2, p3)
        )
        capsule(pen, previous, current, half_width)
        previous = current
    capsule(pen, p3, to_font(*FStemFoot), half_width)
    capsule(pen, to_font(*FCrossbar[0]), to_font(*FCrossbar[1]), half_width)
    add_glyph(font, "f.keycap", pen, FAdvance, ord("f"))


def add_arrows(font):
    for codepoint, (tx, ty) in Arrows.items():
        horizontal = tx != 0
        advance = ArrowLength if horizontal else ArrowWidth
        cx, cy = advance / 2, ArrowMiddle
        nx, ny = -ty, tx
        outline = [
            (
                cx + tx * (ArrowLength / 2 - a * ArrowScale) + nx * (ArrowBox[1] / 2 - b) * ArrowScale,
                cy + ty * (ArrowLength / 2 - a * ArrowScale) + ny * (ArrowBox[1] / 2 - b) * ArrowScale,
            )
            for a, b in ArrowOutline
        ]
        area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(outline, outline[1:] + outline[:1]))
        if area < 0:
            outline.reverse()
        pen = T2CharStringPen(advance, font.getGlyphSet())
        pen.moveTo(point(*outline[0]))
        for corner in outline[1:]:
            pen.lineTo(point(*corner))
        pen.closePath()
        add_glyph(font, f"uni{codepoint:04X}", pen, advance, codepoint)


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
    add_f(font)
    add_arrows(font)
    font.flavor = "woff2"
    font.save(Output)
    print(f"Wrote {Output} ({Output.stat().st_size} bytes)")


if __name__ == "__main__":
    main(sys.argv[1])

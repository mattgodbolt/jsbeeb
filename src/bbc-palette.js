"use strict";

// The 16 standard BBC Micro colours in ABGR format (0xffBBGGRR, little-endian canvas RGBA).
// Colours 0-7 are the primary palette; 8-15 duplicate them as the default solid/non-flash set.
// Imported by both video.js (NulaDefaultPalette) and teletext.js (BbcDefaultCollook) to avoid
// circular imports between those two modules.
export const BbcDefaultPalette = new Uint32Array([
    0xff000000, // 0: black
    0xff0000ff, // 1: red
    0xff00ff00, // 2: green
    0xff00ffff, // 3: yellow
    0xffff0000, // 4: blue
    0xffff00ff, // 5: magenta
    0xffffff00, // 6: cyan
    0xffffffff, // 7: white
    0xff000000, // 8: black (solid duplicate)
    0xff0000ff, // 9: red
    0xff00ff00, // 10: green
    0xff00ffff, // 11: yellow
    0xffff0000, // 12: blue
    0xffff00ff, // 13: magenta
    0xffffff00, // 14: cyan
    0xffffffff, // 15: white
]);

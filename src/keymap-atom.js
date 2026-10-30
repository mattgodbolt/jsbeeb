import {
    characterBinder,
    detectKeyboardLayout,
    keyCodes,
    keyMapBuilder,
    PrintableCharacters,
    stringToKeys,
} from "./keymap.js";

// ATOM

/*
    Acorn Atom

                  &B001 - keyboard matrix column:
                       ~b0 : SPC  [   \   ]   ^  LCK <-> ^-v Lft Rgt
                       ~b1 : Dwn Up  CLR ENT CPY DEL  0   1   2   3
                       ~b2 :  4   5   6   7   8   9   :   ;   <   =
                       ~b3 :  >   ?   @   A   B   C   D   E   F   G
                       ~b4 :  H   I   J   K   L   M   N   O   P   Q
                       ~b5 :  R   S   T   U   V   W   X   Y   Z  ESC
                       ~b6 :                                          Ctrl
                       ~b7 :                                          Shift
                              9   8   7   6   5   4   3   2   1   0

                  &B002 - REPT key
                       ~b6 :                                          Rept

     */

export const ATOM = {
    RIGHT: [0, 0],
    LEFT: [1, 0],
    UP_DOWN: [2, 0],
    LEFT_RIGHT: [3, 0],
    LOCK: [4, 0], //CAPSLOCK

    UP_ARROW: [5, 0], // big uparrow next to break
    RIGHT_SQUARE_BRACKET: [6, 0],
    BACKSLASH: [7, 0],
    LEFT_SQUARE_BRACKET: [8, 0],
    SPACE: [9, 0],

    K3: [0, 1],
    K2: [1, 1],
    K1: [2, 1],
    K0: [3, 1],
    DELETE: [4, 1],
    COPY: [5, 1],
    RETURN: [6, 1],
    CLEAR: [7, 1],
    UP: [8, 1],
    DOWN: [9, 1],

    MINUS_EQUALS: [0, 2],
    COMMA_LESSTHAN: [1, 2],
    SEMICOLON_PLUS: [2, 2],
    COLON_STAR: [3, 2],
    K9: [4, 2],
    K8: [5, 2],
    K7: [6, 2],
    K6: [7, 2],
    K5: [8, 2],
    K4: [9, 2],

    G: [0, 3],
    F: [1, 3],
    E: [2, 3],
    D: [3, 3],
    C: [4, 3],
    B: [5, 3],
    A: [6, 3],
    AT: [7, 3],
    SLASH_QUESTIONMARK: [8, 3], // AND QUESTION MARK
    PERIOD_GREATERTHAN: [9, 3], // AND GREATER

    Q: [0, 4],
    P: [1, 4],
    O: [2, 4],
    N: [3, 4],
    M: [4, 4],
    L: [5, 4],
    K: [6, 4],
    J: [7, 4],
    I: [8, 4],
    H: [9, 4],

    ESCAPE: [0, 5],
    Z: [1, 5],
    Y: [2, 5],
    X: [3, 5],
    W: [4, 5],
    V: [5, 5],
    U: [6, 5],
    T: [7, 5],
    S: [8, 5],
    R: [9, 5],

    // special codes
    CTRL: [0, 6],
    SHIFT: [0, 7],
    REPT: [1, 6],
};

/** Characters the Atom prints with shift held. `!` to `)` are shift and the digit on the same key. */
const ShiftedCharacters = {
    "!": ATOM.K1,
    '"': ATOM.K2,
    "#": ATOM.K3,
    $: ATOM.K4,
    "%": ATOM.K5,
    "&": ATOM.K6,
    "'": ATOM.K7,
    "(": ATOM.K8,
    ")": ATOM.K9,
    "=": ATOM.MINUS_EQUALS,
    "+": ATOM.SEMICOLON_PLUS,
    "*": ATOM.COLON_STAR,
    "<": ATOM.COMMA_LESSTHAN,
    ">": ATOM.PERIOD_GREATERTHAN,
    "?": ATOM.SLASH_QUESTIONMARK,
    "`": ATOM.AT,
    "~": ATOM.UP_ARROW,
    "{": ATOM.LEFT_SQUARE_BRACKET,
    "|": ATOM.BACKSLASH,
    "}": ATOM.RIGHT_SQUARE_BRACKET,
};

/** Characters the Atom prints without shift. */
const UnshiftedCharacters = {
    "\n": ATOM.RETURN,
    "\t": ATOM.SPACE,
    " ": ATOM.SPACE,
    "-": ATOM.MINUS_EQUALS,
    ":": ATOM.COLON_STAR,
    ";": ATOM.SEMICOLON_PLUS,
    ",": ATOM.COMMA_LESSTHAN,
    ".": ATOM.PERIOD_GREATERTHAN,
    "/": ATOM.SLASH_QUESTIONMARK,
    "@": ATOM.AT,
    "^": ATOM.UP_ARROW,
    "[": ATOM.LEFT_SQUARE_BRACKET,
    "\\": ATOM.BACKSLASH,
    "]": ATOM.RIGHT_SQUARE_BRACKET,
};

const ShiftMakesNoDifference = new Set([ATOM.SPACE]);

/**
 * How an Atom keyboard types a character, as `bbcKeyForCharacter` does for the BBC. Only
 * letters say which way the lock has to be; everything else prints the same either way, so
 * leaves `upperCase` out.
 *
 * @param {string} char one character
 * @returns {{key: [number, number], shift: boolean, upperCase?: boolean}|null} null if the Atom has no such character
 */
export function atomKeyForCharacter(char) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return { key: ATOM[char], shift: false, upperCase: true };
    if (code >= 97 && code <= 122) return { key: ATOM[String.fromCharCode(code - 32)], shift: false, upperCase: false };
    if (code >= 48 && code <= 57) return { key: ATOM["K" + char], shift: false };
    const shifted = ShiftedCharacters[char];
    if (shifted) return { key: shifted, shift: true };
    const unshifted = UnshiftedCharacters[char];
    if (unshifted) return { key: unshifted, shift: false };
    return null;
}

export function stringToATOMKeys(str) {
    return stringToKeys(str, atomKeyForCharacter, ATOM.SHIFT, ATOM.LOCK);
}

export function getKeyMapAtom(keyLayout) {
    const isUKlayout = detectKeyboardLayout() === "UK";
    const { map, finish } = keyMapBuilder(ATOM);

    // these keys are in the same place on PC/Mac and ATOM keyboards
    // including shifted characters
    // so can be the same for "natural" and "gaming"
    map(keyCodes.COMMA, ATOM.COMMA_LESSTHAN);
    map(keyCodes.PERIOD, ATOM.PERIOD_GREATERTHAN);
    map(keyCodes.SLASH, ATOM.SLASH_QUESTIONMARK);
    map(keyCodes.SPACE, ATOM.SPACE);
    map(keyCodes.ENTER, ATOM.RETURN);

    // other keys to map to these in "game" layout too
    map(keyCodes.F9, ATOM.CLEAR); // not actually on an ATOM keyboard
    map(keyCodes.LEFT, ATOM.LEFT); // arrow left
    map(keyCodes.RIGHT, ATOM.LEFT_RIGHT); // arrow right
    map(keyCodes.DOWN, ATOM.DOWN); // arrow down
    map(keyCodes.UP, ATOM.UP_DOWN); // arrow up

    map(keyCodes.BACKSPACE, ATOM.DELETE); // delete
    map(keyCodes.DELETE, ATOM.DELETE); // delete

    map(keyCodes.ESCAPE, ATOM.ESCAPE);
    map(keyCodes.TAB, ATOM.COPY);

    map(keyCodes.F10, ATOM.REPT);

    map(keyCodes.F1, ATOM.LOCK); // which is better for ATOM.LOCK - use all of them?
    map(keyCodes.ALT_LEFT, ATOM.LOCK);

    if (keyLayout === "natural") {
        // Keyed by the character the host keyboard produces, as the BBC's is in `getKeyMap`.
        const mapCharacter = characterBinder(map, atomKeyForCharacter, ShiftMakesNoDifference);
        for (const char of PrintableCharacters) mapCharacter(char, char);

        map(keyCodes.END, ATOM.COPY);
        map(keyCodes.HOME, ATOM.LOCK);
        map(keyCodes.CAPSLOCK, ATOM.LOCK);
        map(keyCodes.F11, ATOM.COPY);

        map(keyCodes.CTRL_LEFT, ATOM.CTRL);
        map(keyCodes.CTRL_RIGHT, ATOM.CTRL);
        map(keyCodes.SHIFT_LEFT, ATOM.SHIFT);
        map(keyCodes.SHIFT_RIGHT, ATOM.SHIFT);
    } else if (keyLayout === "gaming") {
        // gaming keyboard

        // 1st row
        map(keyCodes.ESCAPE, ATOM.ESCAPE);

        // 2nd row
        map(keyCodes.BACK_QUOTE, ATOM.ESCAPE);
        map(keyCodes.K1, ATOM.K1);
        map(keyCodes.K2, ATOM.K2);
        map(keyCodes.K3, ATOM.K3);
        map(keyCodes.K4, ATOM.K4);
        map(keyCodes.K5, ATOM.K5);
        map(keyCodes.K6, ATOM.K6);
        map(keyCodes.K7, ATOM.K7);
        map(keyCodes.K8, ATOM.K8);
        map(keyCodes.K9, ATOM.K9);
        map(keyCodes.K0, ATOM.K0);
        map(keyCodes.MINUS, ATOM.MINUS_EQUALS);
        map(keyCodes.EQUALS, ATOM.UP_ARROW);
        map(keyCodes.BACKSPACE, ATOM.BACKSLASH);
        map(keyCodes.INSERT, ATOM.LEFT);
        map(keyCodes.HOME, ATOM.RIGHT);

        // 3rd row
        map(keyCodes.LEFT_SQUARE_BRACKET, ATOM.AT);
        map(keyCodes.RIGHT_SQUARE_BRACKET, ATOM.LEFT_SQUARE_BRACKET);
        // no key for ATOM.UNDERSCORE_POUND in UK
        // see 4th row for US mapping keyCodes.BACKSLASH
        map(keyCodes.DELETE, ATOM.UP);
        map(keyCodes.END, ATOM.DOWN);

        // 4th row
        // no key for ATOM.CAPSLOCK (mapped to CTRL_LEFT below)
        map(keyCodes.CAPSLOCK, ATOM.CTRL);
        map(keyCodes.SEMICOLON, ATOM.SEMICOLON_PLUS);
        map(keyCodes.APOSTROPHE, ATOM.COLON_STAR);
        // UK prints `#~` on this key, a US board `\|`.
        map(keyCodes.BACKSLASH, isUKlayout ? ATOM.RIGHT_SQUARE_BRACKET : ATOM.BACKSLASH);

        // Only a 102-key board has a key here, so only there can the left shift be spared.
        map(keyCodes.SHIFT_LEFT, isUKlayout ? ATOM.LOCK : ATOM.SHIFT);
        map(keyCodes.INTL_BACKSLASH, ATOM.SHIFT);

        // 5th row

        // Atom uses CTRL as shift, so map PC Ctrl to Atom's LOCK key
        map(keyCodes.CTRL_LEFT, ATOM.LOCK);

        // ATOM.DELETE is covered by the common mapping above
        map(keyCodes.CTRL_RIGHT, ATOM.COPY);
    } else {
        // Physical, and default
        // Like a real ATOM
        // mainly the CTRL key is still CTRL (as CAPSLOCK locks on the MAC)
        // UP/DOWN/LEFT/RIGHT are using arrow keys
        // REPT is using RIGHT_SHIFT
        // note: LOCK is on LEFT_ALT
        map(keyCodes.HOME, ATOM.LOCK);
        map(keyCodes.K1, ATOM.K1);
        map(keyCodes.K2, ATOM.K2);
        map(keyCodes.K3, ATOM.K3);
        map(keyCodes.K4, ATOM.K4);
        map(keyCodes.K5, ATOM.K5);
        map(keyCodes.K6, ATOM.K6);
        map(keyCodes.K7, ATOM.K7);
        map(keyCodes.K8, ATOM.K8);
        map(keyCodes.K9, ATOM.K9);
        map(keyCodes.K0, ATOM.K0);
        map(keyCodes.MINUS, ATOM.MINUS_EQUALS); // - / _ becomes - / =
        map(keyCodes.EQUALS, ATOM.COLON_STAR); // = / + becomes  : / *
        //BREAK is code in 'main.js' to F12

        // Q-P normal
        map(keyCodes.LEFT_SQUARE_BRACKET, ATOM.AT); // maps to @
        map(keyCodes.RIGHT_SQUARE_BRACKET, ATOM.BACKSLASH); // maps to \

        map(keyCodes.SHIFT_LEFT, ATOM.CTRL); // using CAPSLOCK for CTRL doesn't work on MAC
        map(keyCodes.CTRL_LEFT, ATOM.SHIFT);

        map(keyCodes.CTRL_RIGHT, ATOM.SHIFT);
        map(keyCodes.SHIFT_RIGHT, ATOM.REPT);

        // A-L normal
        map(keyCodes.SEMICOLON, ATOM.SEMICOLON_PLUS); // ; / +
        map(keyCodes.APOSTROPHE, ATOM.LEFT_SQUARE_BRACKET);
        map(keyCodes.BACKSLASH, ATOM.RIGHT_SQUARE_BRACKET);
        map(keyCodes.INTL_BACKSLASH, ATOM.RIGHT_SQUARE_BRACKET);

        // Z - M normal
    }

    return finish();
}

/**
 * The Atom's counterpart of `BbcGamepadKeys`: the keys in the matrix's column 0 (Q, =, 3 and G for the
 * D-pad, the right arrow for A), with SPACE on Start.
 */
export const AtomGamepadKeys = {
    0: ATOM.RIGHT,
    9: ATOM.SPACE,
    12: ATOM.Q,
    13: ATOM.MINUS_EQUALS,
    14: ATOM.K3,
    15: ATOM.G,
};

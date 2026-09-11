import { runningInNode } from "./loader.js";

export const userKeymap = [];

export const BBC = {
    SEMICOLON_PLUS: [7, 5],
    MINUS: [7, 1],
    LEFT_SQUARE_BRACKET: [8, 3],
    RIGHT_SQUARE_BRACKET: [8, 5],
    COMMA: [6, 6],
    PERIOD: [7, 6],
    SLASH: [8, 6],
    SHIFTLOCK: [0, 5],
    TAB: [0, 6],
    RETURN: [9, 4],
    DELETE: [9, 5],
    COPY: [9, 6],
    SHIFT: [0, 0],
    ESCAPE: [0, 7],
    CTRL: [1, 0],
    CAPSLOCK: [0, 4],
    LEFT: [9, 1],
    UP: [9, 3],
    RIGHT: [9, 7],
    DOWN: [9, 2],
    K0: [7, 2],
    K1: [0, 3],
    K2: [1, 3],
    K3: [1, 1],
    K4: [2, 1],
    K5: [3, 1],
    K6: [4, 3],
    K7: [4, 2],
    K8: [5, 1],
    K9: [6, 2],

    Q: [0, 1],
    W: [1, 2],
    E: [2, 2],
    R: [3, 3],
    T: [3, 2],
    Y: [4, 4],
    U: [5, 3],
    I: [5, 2],
    O: [6, 3],
    P: [7, 3],

    A: [1, 4],
    S: [1, 5],
    D: [2, 3],
    F: [3, 4],
    G: [3, 5],
    H: [4, 5],
    J: [5, 4],
    K: [6, 4],
    L: [6, 5],

    Z: [1, 6],
    X: [2, 4],
    C: [2, 5],
    V: [3, 6],
    B: [4, 6],
    N: [5, 5],
    M: [5, 6],

    F0: [0, 2],
    F1: [1, 7],
    F2: [2, 7],
    F3: [3, 7],
    F4: [4, 1],
    F5: [4, 7],
    F6: [5, 7],
    F7: [6, 1],
    F8: [6, 7],
    F9: [7, 7],

    SPACE: [2, 6],

    UNDERSCORE_POUND: [8, 2],
    AT: [7, 4],
    COLON_STAR: [8, 4],
    PIPE_BACKSLASH: [8, 7],
    HAT_TILDE: [8, 1],

    // row 1
    NUMPADPLUS: [10, 3],
    NUMPADMINUS: [11, 3],
    NUMPADSLASH: [10, 4],
    NUMPADASTERISK: [11, 5],

    // row 2
    NUMPAD7: [11, 1],
    NUMPAD8: [10, 2],
    NUMPAD9: [11, 2],
    NUMPADHASH: [10, 5],
    // row 3
    NUMPAD4: [10, 7],
    NUMPAD5: [11, 7],
    NUMPAD6: [10, 1],
    NUMPAD_DELETE: [11, 4],
    //row4
    NUMPAD1: [11, 6],
    NUMPAD2: [12, 7],
    NUMPAD3: [12, 6],
    NUMPADCOMMA: [12, 5],

    //row 5
    NUMPAD0: [10, 6],
    NUMPAD_DECIMAL_POINT: [12, 4],
    NUMPADENTER: [12, 3],
};

/**
 * What a character costs on a BBC keyboard: which key, and whether shift is held while it is
 * pressed. `!` is shift and `1`; `^` is its own unshifted key. Lower case is the same key as
 * upper with the caps lock the other way, which `upperCase` says.
 *
 * The one table for this; the natural keyboard layout and pasting both read it.
 *
 * @param {string} char one character
 * @returns {{key: [number, number], shift: boolean, upperCase: boolean}|null} null if the BBC has no such character
 */
export function bbcKeyForCharacter(char) {
    const code = char.charCodeAt(0);
    if (code >= 65 && code <= 90) return { key: BBC[char], shift: false, upperCase: true };
    if (code >= 97 && code <= 122) return { key: BBC[String.fromCharCode(code - 32)], shift: false, upperCase: false };
    if (code >= 48 && code <= 57) return { key: BBC["K" + char], shift: false, upperCase: true };
    const shifted = ShiftedCharacters[char];
    if (shifted) return { key: shifted, shift: true, upperCase: true };
    const unshifted = UnshiftedCharacters[char];
    if (unshifted) return { key: unshifted, shift: false, upperCase: true };
    return null;
}

/** Characters the BBC prints with shift held. `!` to `)` are shift and the digit above them. */
const ShiftedCharacters = {
    "!": BBC.K1,
    '"': BBC.K2,
    "#": BBC.K3,
    $: BBC.K4,
    "%": BBC.K5,
    "&": BBC.K6,
    "'": BBC.K7,
    "(": BBC.K8,
    ")": BBC.K9,
    "=": BBC.MINUS,
    "~": BBC.HAT_TILDE,
    "|": BBC.PIPE_BACKSLASH,
    "{": BBC.LEFT_SQUARE_BRACKET,
    "+": BBC.SEMICOLON_PLUS,
    "*": BBC.COLON_STAR,
    "}": BBC.RIGHT_SQUARE_BRACKET,
    "<": BBC.COMMA,
    ">": BBC.PERIOD,
    "?": BBC.SLASH,
};

/** Characters the BBC prints without shift. */
const UnshiftedCharacters = {
    "\n": BBC.RETURN,
    "\t": BBC.TAB,
    " ": BBC.SPACE,
    "-": BBC.MINUS,
    "^": BBC.HAT_TILDE,
    "\\": BBC.PIPE_BACKSLASH,
    "@": BBC.AT,
    "[": BBC.LEFT_SQUARE_BRACKET,
    _: BBC.UNDERSCORE_POUND,
    ";": BBC.SEMICOLON_PLUS,
    ":": BBC.COLON_STAR,
    "]": BBC.RIGHT_SQUARE_BRACKET,
    ",": BBC.COMMA,
    ".": BBC.PERIOD,
    "/": BBC.SLASH,
};

export function stringToBBCKeys(str) {
    const array = [];
    let shiftState = false;
    let capsLockState = true;
    for (const char of str) {
        const needs = bbcKeyForCharacter(char);
        if (!needs) continue;

        if (needs.shift !== shiftState) {
            array.push(BBC.SHIFT);
            shiftState = needs.shift;
        }
        if (needs.upperCase !== capsLockState) {
            array.push(BBC.CAPSLOCK);
            capsLockState = needs.upperCase;
        }
        array.push(needs.key);
    }

    if (shiftState) array.push(BBC.SHIFT);
    if (!capsLockState) array.push(BBC.CAPSLOCK);
    return array;
}

/**
 * Host keys by physical position, as `KeyboardEvent.code` names them:
 * https://www.w3.org/TR/uievents-code/
 *
 * The names on the left are jsbeeb's own, and the `KEY.` URL parameters use them.
 */
export const keyCodes = {
    SEMICOLON: "Semicolon",
    APOSTROPHE: "Quote",
    MUTE: "AudioVolumeMute",
    MINUS: "Minus",
    EQUALS: "Equal",
    BACK_QUOTE: "Backquote",
    BACKSPACE: "Backspace",
    TAB: "Tab",
    ENTER: "Enter",
    BREAK: "Pause",
    CAPSLOCK: "CapsLock",
    ESCAPE: "Escape",
    SPACE: "Space",
    PAGEUP: "PageUp",
    PAGEDOWN: "PageDown",
    END: "End",
    HOME: "Home",
    LEFT: "ArrowLeft",
    UP: "ArrowUp",
    RIGHT: "ArrowRight",
    DOWN: "ArrowDown",
    PRINTSCREEN: "PrintScreen",
    INSERT: "Insert",
    DELETE: "Delete",
    K0: "Digit0",
    K1: "Digit1",
    K2: "Digit2",
    K3: "Digit3",
    K4: "Digit4",
    K5: "Digit5",
    K6: "Digit6",
    K7: "Digit7",
    K8: "Digit8",
    K9: "Digit9",
    A: "KeyA",
    B: "KeyB",
    C: "KeyC",
    D: "KeyD",
    E: "KeyE",
    F: "KeyF",
    G: "KeyG",
    H: "KeyH",
    I: "KeyI",
    J: "KeyJ",
    K: "KeyK",
    L: "KeyL",
    M: "KeyM",
    N: "KeyN",
    O: "KeyO",
    P: "KeyP",
    Q: "KeyQ",
    R: "KeyR",
    S: "KeyS",
    T: "KeyT",
    U: "KeyU",
    V: "KeyV",
    W: "KeyW",
    X: "KeyX",
    Y: "KeyY",
    Z: "KeyZ",
    /* also COMMAND on Mac */
    WINDOWS: "MetaLeft",
    WINDOWS_RIGHT: "MetaRight",
    MENU: "ContextMenu",
    NUMPAD0: "Numpad0",
    NUMPAD1: "Numpad1",
    NUMPAD2: "Numpad2",
    NUMPAD3: "Numpad3",
    NUMPAD4: "Numpad4",
    NUMPAD5: "Numpad5",
    NUMPAD6: "Numpad6",
    NUMPAD7: "Numpad7",
    NUMPAD8: "Numpad8",
    NUMPAD9: "Numpad9",
    NUMPADASTERISK: "NumpadMultiply",
    NUMPADPLUS: "NumpadAdd",
    NUMPAD_DECIMAL_COMMA: "NumpadComma",
    NUMPADMINUS: "NumpadSubtract",
    NUMPAD_DECIMAL_POINT: "NumpadDecimal",
    NUMPADSLASH: "NumpadDivide",
    NUMPADENTER: "NumpadEnter",
    F1: "F1",
    F2: "F2",
    F3: "F3",
    F4: "F4",
    F5: "F5",
    F6: "F6",
    F7: "F7",
    F8: "F8",
    F9: "F9",
    F10: "F10",
    F11: "F11",
    F12: "F12",
    NUMLOCK: "NumLock",
    SCROLL_LOCK: "ScrollLock",
    VOLUMEUP: "AudioVolumeUp",
    VOLUMEDOWN: "AudioVolumeDown",
    FASTFORWARD: "MediaTrackNext",
    FASTREWIND: "MediaTrackPrevious",
    PLAYPAUSE: "MediaPlayPause",
    COMMA: "Comma",
    PERIOD: "Period",
    SLASH: "Slash",
    LEFT_SQUARE_BRACKET: "BracketLeft",
    RIGHT_SQUARE_BRACKET: "BracketRight",
    BACKSLASH: "Backslash",
    /* only on a 102-key board, between the left shift and the Z */
    INTL_BACKSLASH: "IntlBackslash",
    SHIFT_LEFT: "ShiftLeft",
    SHIFT_RIGHT: "ShiftRight",
    ALT_LEFT: "AltLeft",
    ALT_RIGHT: "AltRight",
    CTRL_LEFT: "ControlLeft",
    CTRL_RIGHT: "ControlRight",
};

/**
 * Other names a `KEY.` parameter may use for a host key: one that covers both sides of a pair,
 * or a second name for a key that is printed differently on different keyboards.
 */
export const keyCodeAliases = {
    SHIFT: [keyCodes.SHIFT_LEFT, keyCodes.SHIFT_RIGHT],
    CTRL: [keyCodes.CTRL_LEFT, keyCodes.CTRL_RIGHT],
    ALT: [keyCodes.ALT_LEFT, keyCodes.ALT_RIGHT],
    HASH: [keyCodes.BACKSLASH],
    /* an Apple keyboard prints "clear" on the key a PC calls num lock */
    CLEAR: [keyCodes.NUMLOCK],
};

/**
 * The host keys a jsbeeb key name stands for, or an empty array if it names none.
 * @param {string} name a `keyCodes` name, or an alias covering more than one
 * @returns {string[]} `KeyboardEvent.code` names
 */
export function hostKeyCodes(name) {
    if (keyCodes[name]) return [keyCodes[name]];
    return keyCodeAliases[name] ?? [];
}

export function detectKeyboardLayout() {
    if (runningInNode) {
        return "UK";
    }
    if (localStorage.keyboardLayout) {
        return localStorage.keyboardLayout === "US" ? "US" : "UK";
    }
    if (navigator.language) {
        if (navigator.language.toLowerCase() === "en-gb") return "UK";
        if (navigator.language.toLowerCase() === "en-us") return "US";
    }
    return "UK"; // Default guess of UK
}

export function getKeyMap(keyLayout) {
    const isUKlayout = detectKeyboardLayout() === "UK";
    const keys2 = [];

    // shift pressed
    keys2[true] = {};

    // shift not pressed
    keys2[false] = {};

    // Create a key map entry that overrides the BBC SHIFT state while held.
    // Used in natural keyboard for keys where the PC and BBC shift states
    // differ for the same character (e.g. US Shift+6 = ^ needs BBC HAT_TILDE
    // without shift, even though the physical shift key is held).
    function withShiftOverride(bbcKey, bbcShift) {
        return [bbcKey[0], bbcKey[1], bbcShift];
    }

    // shiftDown MUST be true or false (not undefined)
    function doMap(s, colRow, shiftDown) {
        if (keys2[shiftDown][s] && keys2[shiftDown][s] !== colRow) {
            console.log(
                "Warning: duplicate binding for key",
                (shiftDown ? "<SHIFT>" : "") + s,
                colRow,
                keys2[shiftDown][s],
            );
        }
        keys2[shiftDown][s] = colRow;
    }

    // Overriding a default is the point here, so unlike `map` this doesn't warn about the clash.
    function remap(s, colRow) {
        keys2[true][s] = colRow;
        keys2[false][s] = colRow;
    }

    // shiftDown undefined -> map both
    function map(s, colRow, shiftDown) {
        if (!s || !colRow) {
            console.log("error binding key", s, colRow);
        }

        if (shiftDown === undefined) {
            doMap(s, colRow, true);
            doMap(s, colRow, false);
        } else {
            doMap(s, colRow, shiftDown);
        }
    }

    map(keyCodes.Q, BBC.Q);
    map(keyCodes.W, BBC.W);
    map(keyCodes.E, BBC.E);
    map(keyCodes.R, BBC.R);
    map(keyCodes.T, BBC.T);
    map(keyCodes.Y, BBC.Y);
    map(keyCodes.U, BBC.U);
    map(keyCodes.I, BBC.I);
    map(keyCodes.O, BBC.O);
    map(keyCodes.P, BBC.P);

    map(keyCodes.A, BBC.A);
    map(keyCodes.S, BBC.S);
    map(keyCodes.D, BBC.D);
    map(keyCodes.F, BBC.F);
    map(keyCodes.G, BBC.G);
    map(keyCodes.H, BBC.H);
    map(keyCodes.J, BBC.J);
    map(keyCodes.K, BBC.K);
    map(keyCodes.L, BBC.L);

    map(keyCodes.Z, BBC.Z);
    map(keyCodes.X, BBC.X);
    map(keyCodes.C, BBC.C);
    map(keyCodes.V, BBC.V);
    map(keyCodes.B, BBC.B);
    map(keyCodes.N, BBC.N);
    map(keyCodes.M, BBC.M);

    map(keyCodes.F10, BBC.F0); // F0 (mapped to F10)
    map(keyCodes.F1, BBC.F1);
    map(keyCodes.F2, BBC.F2);
    map(keyCodes.F3, BBC.F3);
    map(keyCodes.F4, BBC.F4);
    map(keyCodes.F5, BBC.F5);
    map(keyCodes.F6, BBC.F6);
    map(keyCodes.F7, BBC.F7);
    map(keyCodes.F8, BBC.F8);
    map(keyCodes.F9, BBC.F9);

    // these keys are in the same place on PC and BBC keyboards
    // including shifted characters
    // so can be the same for "natural" and "gaming"
    map(keyCodes.COMMA, BBC.COMMA);
    map(keyCodes.PERIOD, BBC.PERIOD);
    map(keyCodes.SLASH, BBC.SLASH);
    map(keyCodes.SPACE, BBC.SPACE);
    map(keyCodes.TAB, BBC.TAB);
    map(keyCodes.ENTER, BBC.RETURN);

    // see later map(keyCodes.SHIFT_LEFT, BBC.SHIFT_LEFT);
    map(keyCodes.SHIFT_RIGHT, BBC.SHIFT);

    // other keys to map to these in "game" layout too
    map(keyCodes.LEFT, BBC.LEFT);
    map(keyCodes.UP, BBC.UP);
    map(keyCodes.RIGHT, BBC.RIGHT);
    map(keyCodes.DOWN, BBC.DOWN);

    if (keyLayout === "natural") {
        // "natural" keyboard

        map(keyCodes.SHIFT_LEFT, BBC.SHIFT);

        // US Keyboard: has Tilde on <Shift>BACK_QUOTE
        map(keyCodes.BACK_QUOTE, isUKlayout ? BBC.UNDERSCORE_POUND : BBC.HAT_TILDE);
        map(keyCodes.APOSTROPHE, isUKlayout ? BBC.AT : BBC.K2, true);
        map(keyCodes.K2, isUKlayout ? BBC.K2 : BBC.AT, true);

        // 1st row
        map(keyCodes.K3, BBC.UNDERSCORE_POUND, true);
        map(keyCodes.K7, BBC.K6, true);
        map(keyCodes.K8, BBC.COLON_STAR, true);
        map(keyCodes.K9, BBC.K8, true);
        map(keyCodes.K0, BBC.K9, true);

        map(keyCodes.K2, BBC.K2, false);
        map(keyCodes.K3, BBC.K3, false);
        map(keyCodes.K7, BBC.K7, false);
        map(keyCodes.K8, BBC.K8, false);
        map(keyCodes.K9, BBC.K9, false);
        map(keyCodes.K0, BBC.K0, false);

        map(keyCodes.K1, BBC.K1);
        map(keyCodes.K4, BBC.K4);
        map(keyCodes.K5, BBC.K5);
        map(keyCodes.K6, BBC.K6, false);
        map(keyCodes.K6, withShiftOverride(BBC.HAT_TILDE, false), true);

        map(keyCodes.MINUS, BBC.MINUS);

        // 2nd row
        map(keyCodes.LEFT_SQUARE_BRACKET, BBC.LEFT_SQUARE_BRACKET);

        map(keyCodes.RIGHT_SQUARE_BRACKET, BBC.RIGHT_SQUARE_BRACKET);

        // 3rd row

        map(keyCodes.SEMICOLON, BBC.SEMICOLON_PLUS);

        map(keyCodes.APOSTROPHE, BBC.COLON_STAR, false);

        // UK prints `#~` on this key, which is the BBC's `^~` pair; a US board prints `\|`.
        map(keyCodes.BACKSLASH, isUKlayout ? BBC.HAT_TILDE : BBC.PIPE_BACKSLASH);
        map(keyCodes.INTL_BACKSLASH, BBC.PIPE_BACKSLASH);

        map(keyCodes.EQUALS, BBC.SEMICOLON_PLUS); // OK for <Shift> at least

        map(keyCodes.END, BBC.COPY);

        map(keyCodes.HOME, BBC.SHIFTLOCK);

        map(keyCodes.F11, BBC.COPY);

        map(keyCodes.ESCAPE, BBC.ESCAPE);

        map(keyCodes.CTRL_LEFT, BBC.CTRL);
        map(keyCodes.CTRL_RIGHT, BBC.CTRL);

        map(keyCodes.CAPSLOCK, BBC.CAPSLOCK);

        map(keyCodes.DELETE, BBC.DELETE);

        map(keyCodes.BACKSPACE, BBC.DELETE);
    } else if (keyLayout === "gaming") {
        // gaming keyboard

        // 1st row
        map(keyCodes.ESCAPE, BBC.F0);

        // 2nd row
        map(keyCodes.BACK_QUOTE, BBC.ESCAPE);
        map(keyCodes.K1, BBC.K1);
        map(keyCodes.K2, BBC.K2);
        map(keyCodes.K3, BBC.K3);
        map(keyCodes.K4, BBC.K4);
        map(keyCodes.K5, BBC.K5);
        map(keyCodes.K6, BBC.K6);
        map(keyCodes.K7, BBC.K7);
        map(keyCodes.K8, BBC.K8);
        map(keyCodes.K9, BBC.K9);
        map(keyCodes.K0, BBC.K0);
        map(keyCodes.MINUS, BBC.MINUS);
        map(keyCodes.EQUALS, BBC.HAT_TILDE);
        map(keyCodes.BACKSPACE, BBC.PIPE_BACKSLASH);
        map(keyCodes.INSERT, BBC.LEFT);
        map(keyCodes.HOME, BBC.RIGHT);

        // 3rd row
        map(keyCodes.LEFT_SQUARE_BRACKET, BBC.AT);
        map(keyCodes.RIGHT_SQUARE_BRACKET, BBC.LEFT_SQUARE_BRACKET);
        // no key for BBC.UNDERSCORE_POUND in UK
        // see 4th row for US mapping keyCodes.BACKSLASH
        map(keyCodes.DELETE, BBC.UP);
        map(keyCodes.END, BBC.DOWN);

        // 4th row
        // no key for BBC.CAPSLOCK (mapped to CTRL_LEFT below)
        map(keyCodes.CAPSLOCK, BBC.CTRL);
        map(keyCodes.SEMICOLON, BBC.SEMICOLON_PLUS);
        map(keyCodes.APOSTROPHE, BBC.COLON_STAR);
        // UK prints `#~` on this key, a US board `\|`.
        map(keyCodes.BACKSLASH, isUKlayout ? BBC.RIGHT_SQUARE_BRACKET : BBC.UNDERSCORE_POUND);

        // Only a 102-key board has a key here, so only there can the left shift be spared.
        map(keyCodes.SHIFT_LEFT, isUKlayout ? BBC.SHIFTLOCK : BBC.SHIFT);
        map(keyCodes.INTL_BACKSLASH, BBC.SHIFT);

        // 5th row

        // for Zalaga
        map(keyCodes.CTRL_LEFT, BBC.CAPSLOCK);
        map(keyCodes.ALT_LEFT, BBC.CTRL);

        // should be 4th row, not enough keys
        map(keyCodes.MENU, BBC.DELETE);
        map(keyCodes.CTRL_RIGHT, BBC.COPY);

        // not in correct location
        map(keyCodes.ALT_RIGHT, BBC.SHIFTLOCK);
    } else {
        // Physical, and default
        map(keyCodes.K1, BBC.K1);
        map(keyCodes.K2, BBC.K2);
        map(keyCodes.K3, BBC.K3);
        map(keyCodes.K4, BBC.K4);
        map(keyCodes.K5, BBC.K5);
        map(keyCodes.K6, BBC.K6);
        map(keyCodes.K7, BBC.K7);
        map(keyCodes.K8, BBC.K8);
        map(keyCodes.K9, BBC.K9);
        map(keyCodes.K0, BBC.K0);
        map(keyCodes.SHIFT_LEFT, BBC.SHIFT);
        map(keyCodes.EQUALS, BBC.HAT_TILDE); // ^~ on +/=
        map(keyCodes.SEMICOLON, BBC.SEMICOLON_PLUS); // ';' / '+'
        map(keyCodes.MINUS, BBC.MINUS); // '-' / '=' mapped to underscore
        map(keyCodes.LEFT_SQUARE_BRACKET, BBC.LEFT_SQUARE_BRACKET); // maps to [{
        map(keyCodes.RIGHT_SQUARE_BRACKET, BBC.RIGHT_SQUARE_BRACKET); // maps to ]}
        map(keyCodes.COMMA, BBC.COMMA); // ',' / '<'
        map(keyCodes.PERIOD, BBC.PERIOD); // '.' / '>'
        map(keyCodes.SLASH, BBC.SLASH); // '/' / '?'
        map(keyCodes.TAB, BBC.TAB); // tab
        map(keyCodes.ENTER, BBC.RETURN); // return
        map(keyCodes.DELETE, BBC.DELETE); // delete
        map(keyCodes.BACKSPACE, BBC.DELETE); // delete
        map(keyCodes.END, BBC.COPY); // copy key is end
        map(keyCodes.HOME, BBC.SHIFTLOCK);
        map(keyCodes.F11, BBC.COPY); // copy key is end for Apple
        map(keyCodes.ESCAPE, BBC.ESCAPE); // escape
        map(keyCodes.CTRL_LEFT, BBC.CTRL);
        map(keyCodes.CTRL_RIGHT, BBC.CTRL);
        map(keyCodes.CAPSLOCK, BBC.CAPSLOCK); // caps (on Rich's/Mike's computer)
        map(keyCodes.LEFT, BBC.LEFT); // arrow left
        map(keyCodes.UP, BBC.UP); // arrow up
        map(keyCodes.RIGHT, BBC.RIGHT); // arrow right
        map(keyCodes.DOWN, BBC.DOWN); // arrow down
        map(keyCodes.APOSTROPHE, BBC.COLON_STAR);

        // None of this last group in great locations.
        // But better to have them mapped at least somewhere.
        map(keyCodes.BACK_QUOTE, BBC.AT);
        map(keyCodes.BACKSLASH, BBC.PIPE_BACKSLASH);
        map(keyCodes.INTL_BACKSLASH, BBC.PIPE_BACKSLASH);
        map(keyCodes.PAGEUP, BBC.UNDERSCORE_POUND);
    }

    // Master
    map(keyCodes.NUMPAD0, BBC.NUMPAD0);
    map(keyCodes.NUMPAD1, BBC.NUMPAD1);
    map(keyCodes.NUMPAD2, BBC.NUMPAD2);
    map(keyCodes.NUMPAD3, BBC.NUMPAD3);
    map(keyCodes.NUMPAD4, BBC.NUMPAD4);
    map(keyCodes.NUMPAD5, BBC.NUMPAD5);
    map(keyCodes.NUMPAD6, BBC.NUMPAD6);
    map(keyCodes.NUMPAD7, BBC.NUMPAD7);
    map(keyCodes.NUMPAD8, BBC.NUMPAD8);
    map(keyCodes.NUMPAD9, BBC.NUMPAD9);
    map(keyCodes.NUMPAD_DECIMAL_POINT, BBC.NUMPAD_DECIMAL_POINT);

    // "natural" mapping
    map(keyCodes.NUMPADPLUS, BBC.NUMPADPLUS);
    map(keyCodes.NUMPADMINUS, BBC.NUMPADMINUS);
    map(keyCodes.NUMPADSLASH, BBC.NUMPADSLASH);
    map(keyCodes.NUMPADASTERISK, BBC.NUMPADASTERISK);
    //map(???, BBC.NUMPADCOMMA);
    //map(???, BBC.NUMPADHASH);
    map(keyCodes.NUMPADENTER, BBC.NUMPADENTER);

    // TODO(#748) "game" mapping
    // eg Master Dunjunz needs # Del 3 , * Enter
    // https://web.archive.org/web/20080305042238/http://bbc.nvg.org/doc/games/Dunjunz-docs.txt

    // `KEY.` URL parameters, applied last so they win. Not consumed: this map is rebuilt on
    // layout and model changes, and the user's mapping has to survive that.
    for (const mapping of userKeymap) {
        for (const code of hostKeyCodes(mapping.native)) remap(code, BBC[mapping.key]);
    }

    return keys2;
}

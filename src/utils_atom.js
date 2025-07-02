"use strict";

import * as utils from "./utils.js";
const keyCodes = utils.keyCodes;
const userKeymap = utils.userKeymap;
const isUKlayout = utils.isUKlayout;

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

export function stringToATOMKeys(str) {
    var array = [];
    var i;
    var shiftState = false;
    var capsLockState = true;
    for (i = 0; i < str.length; ++i) {
        var c = str.charCodeAt(i);
        var charStr = str.charAt(i);
        var atomKey = null;
        var needsShift = false;
        var needsCapsLock = true;
        if (c >= 65 && c <= 90) {
            // A-Z
            atomKey = ATOM[charStr];
        } else if (c >= 97 && c <= 122) {
            // a-z
            charStr = String.fromCharCode(c - 32);
            atomKey = ATOM[charStr];
            needsCapsLock = false;
        } else if (c >= 48 && c <= 57) {
            // 0-9
            atomKey = ATOM["K" + charStr];
        } else if (c >= 33 && c <= 41) {
            // ! to )
            charStr = String.fromCharCode(c + 16);
            atomKey = ATOM["K" + charStr];
            needsShift = true;
        } else {
            switch (charStr) {
                case "\n":
                    atomKey = ATOM.RETURN;
                    break;
                case "\t":
                    atomKey = ATOM.TAB;
                    break;
                case " ":
                    atomKey = ATOM.SPACE;
                    break;
                case "-":
                    atomKey = ATOM.MINUS_EQUALS;
                    break;
                case "=":
                    atomKey = ATOM.MINUS_EQUALS;
                    needsShift = true;
                    break;
                // case '^':
                //     atomKey = ATOM.HAT_TILDE;
                //     break;
                // case '~':
                //     atomKey = ATOM.HAT_TILDE; needsShift = true;
                //     break;
                case "\\":
                    atomKey = ATOM.BACKSLASH;
                    break;
                // case '|':
                //     atomKey = ATOM.PIPE_BACKSLASH; needsShift = true;
                //     break;
                case "@":
                    atomKey = ATOM.AT;
                    break;
                case "[":
                    atomKey = ATOM.LEFT_SQUARE_BRACKET;
                    break;
                // case '{':
                //     atomKey = ATOM.LEFT_SQUARE_BRACKET; needsShift = true;
                //     break;
                // case '_':
                //     atomKey = ATOM.UNDERSCORE_POUND;
                //     break;
                case ";":
                    atomKey = ATOM.SEMICOLON_PLUS;
                    break;
                case "+":
                    atomKey = ATOM.SEMICOLON_PLUS;
                    needsShift = true;
                    break;
                case ":":
                    atomKey = ATOM.COLON_STAR;
                    break;
                case "*":
                    atomKey = ATOM.COLON_STAR;
                    needsShift = true;
                    break;
                case "]":
                    atomKey = ATOM.RIGHT_SQUARE_BRACKET;
                    break;
                // case '}':
                //     atomKey = ATOM.RIGHT_SQUARE_BRACKET; needsShift = true;
                //     break;
                case ",":
                    atomKey = ATOM.COMMA_LESSTHAN;
                    break;
                case "<":
                    atomKey = ATOM.COMMA_LESSTHAN;
                    needsShift = true;
                    break;
                case ".":
                    atomKey = ATOM.PERIOD_GREATERTHAN;
                    break;
                case ">":
                    atomKey = ATOM.PERIOD_GREATERTHAN;
                    needsShift = true;
                    break;
                case "/":
                    atomKey = ATOM.SLASH_QUESTIONMARK;
                    break;
                case "?":
                    atomKey = ATOM.SLASH_QUESTIONMARK;
                    needsShift = true;
                    break;
            }
        }

        if (!atomKey) continue;

        if ((needsShift && !shiftState) || (!needsShift && shiftState)) {
            array.push(ATOM.SHIFT);
            shiftState = !shiftState;
        }
        if ((needsCapsLock && !capsLockState) || (!needsCapsLock && capsLockState)) {
            array.push(ATOM.LOCK);
            capsLockState = !capsLockState;
        }
        array.push(atomKey);
    }

    if (shiftState) array.push(ATOM.SHIFT);
    if (!capsLockState) array.push(ATOM.LOCK);
    return array;
}

export function getKeyMapAtom(keyLayout) {
    var keys2 = [];

    // shift pressed
    keys2[true] = {};

    // shift not pressed
    keys2[false] = {};

    // shiftDown MUST be true or false (not undefined)
    function doMap(s, colRow, shiftDown) {
        if (keys2[shiftDown][s] && keys2[shiftDown][s] !== colRow) {
            console.log(
                "Warning: duplicate binding for atom key",
                (shiftDown ? "<SHIFT>" : "") + s,
                colRow,
                keys2[shiftDown][s],
            );
        }
        keys2[shiftDown][s] = colRow;
    }

    // shiftDown undefined -> map both
    function map(s, colRow, shiftDown) {
        if ((!s && s !== 0) || !colRow) {
            console.log("error binding key", s, colRow);
        }
        if (typeof s === "string") {
            s = s.charCodeAt(0);
        }

        if (shiftDown === undefined) {
            doMap(s, colRow, true);
            doMap(s, colRow, false);
        } else {
            doMap(s, colRow, shiftDown);
        }
    }

    map(keyCodes.Q, ATOM.Q);
    map(keyCodes.W, ATOM.W);
    map(keyCodes.E, ATOM.E);
    map(keyCodes.R, ATOM.R);
    map(keyCodes.T, ATOM.T);
    map(keyCodes.Y, ATOM.Y);
    map(keyCodes.U, ATOM.U);
    map(keyCodes.I, ATOM.I);
    map(keyCodes.O, ATOM.O);
    map(keyCodes.P, ATOM.P);

    map(keyCodes.A, ATOM.A);
    map(keyCodes.S, ATOM.S);
    map(keyCodes.D, ATOM.D);
    map(keyCodes.F, ATOM.F);
    map(keyCodes.G, ATOM.G);
    map(keyCodes.H, ATOM.H);
    map(keyCodes.J, ATOM.J);
    map(keyCodes.K, ATOM.K);
    map(keyCodes.L, ATOM.L);

    map(keyCodes.Z, ATOM.Z);
    map(keyCodes.X, ATOM.X);
    map(keyCodes.C, ATOM.C);
    map(keyCodes.V, ATOM.V);
    map(keyCodes.B, ATOM.B);
    map(keyCodes.N, ATOM.N);
    map(keyCodes.M, ATOM.M);

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
    map(keyCodes.F11, ATOM.UP_ARROW);

    map(keyCodes.F10, ATOM.REPT);

    map(keyCodes.F1, ATOM.LOCK); // which is better for ATOM.LOCK - use all of them?
    map(keyCodes.WINDOWS, ATOM.LOCK);
    map(keyCodes.ALT_LEFT, ATOM.LOCK);

    if (keyLayout === "natural") {
        // "natural" keyboard
        // Like a PC/Mac keyboard

        // US Keyboard: has Tilde on <Shift>BACK_QUOTE
        map(keyCodes.BACK_QUOTE, ATOM.UP_ARROW); // ` on PC, § on Mac
        map(keyCodes.APOSTROPHE, isUKlayout ? ATOM.AT : ATOM.K2, true);
        map(keyCodes.K2, isUKlayout ? ATOM.K2 : ATOM.AT, true);

        // 1st row
        map(keyCodes.K3, ATOM.K3, true);
        map(keyCodes.K6, ATOM.UP_ARROW, true);
        map(keyCodes.K7, ATOM.K6, true);
        map(keyCodes.K8, ATOM.COLON_STAR, true);
        map(keyCodes.K9, ATOM.K8, true);
        map(keyCodes.K0, ATOM.K9, true);

        map(keyCodes.K2, ATOM.K2, false);
        map(keyCodes.K3, ATOM.K3, false);
        map(keyCodes.K6, ATOM.K6, false);
        map(keyCodes.K7, ATOM.K7, false);
        map(keyCodes.K8, ATOM.K8, false);
        map(keyCodes.K9, ATOM.K9, false);
        map(keyCodes.K0, ATOM.K0, false);

        map(keyCodes.K1, ATOM.K1);
        map(keyCodes.K4, ATOM.K4);
        map(keyCodes.K5, ATOM.K5);

        // 3rd row

        map(keyCodes.HASH, ATOM.HASH); // OK for <Shift> at least

        map(keyCodes.MINUS, ATOM.MINUS_EQUALS);

        // 2nd row
        map(keyCodes.LEFT_SQUARE_BRACKET, ATOM.LEFT_SQUARE_BRACKET);

        map(keyCodes.RIGHT_SQUARE_BRACKET, ATOM.RIGHT_SQUARE_BRACKET);

        // 3rd row

        map(keyCodes.SEMICOLON, ATOM.SEMICOLON_PLUS);

        map(keyCodes.APOSTROPHE, ATOM.COLON_STAR, false);

        map(keyCodes.EQUALS, ATOM.SEMICOLON_PLUS); // OK for <Shift> at least

        map(keyCodes.END, ATOM.COPY);
        map(keyCodes.F11, ATOM.COPY);

        map(keyCodes.CTRL, ATOM.CTRL);
        map(keyCodes.CTRL_LEFT, ATOM.CTRL);
        map(keyCodes.CTRL_RIGHT, ATOM.CTRL);
        map(keyCodes.SHIFT, ATOM.SHIFT);
        map(keyCodes.SHIFT_LEFT, ATOM.SHIFT);
        map(keyCodes.SHIFT_RIGHT, ATOM.SHIFT);

        map(keyCodes.BACKSLASH, ATOM.BACKSLASH);
    } else if (keyLayout === "gaming") {
        // gaming keyboard

        // 1st row
        map(keyCodes.ESCAPE, ATOM.F0);

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
        map(keyCodes.EQUALS, ATOM.HAT_TILDE);
        map(keyCodes.BACKSPACE, ATOM.PIPE_BACKSLASH);
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
        // UK keyboard (key missing on US)
        map(keyCodes.HASH, ATOM.RIGHT_SQUARE_BRACKET);

        // UK has extra key \| for SHIFT
        map(keyCodes.SHIFT_LEFT, isUKlayout ? ATOM.SHIFTLOCK : ATOM.SHIFT);
        // UK: key is between SHIFT and Z
        // US: key is above ENTER
        map(keyCodes.BACKSLASH, isUKlayout ? ATOM.SHIFT : ATOM.UNDERSCORE_POUND);

        // 5th row

        // for Zalaga
        map(keyCodes.CTRL_LEFT, ATOM.CAPSLOCK);
        map(keyCodes.SHIFT, ATOM.CTRL);

        // should be 4th row, not enough keys
        map(keyCodes.DELETE, ATOM.DELETE);
        map(keyCodes.CTRL_RIGHT, ATOM.COPY);
    } else {
        // Physical, and default
        // Like a real ATOM
        // mainly the CTRL key is still CTRL (as CAPSLOCK locks on the MAC)
        // UP/DOWN/LEFT/RIGHT are using arrow keys
        // REPT is using the RIGHT_ALT
        // note: LOCK is on LEFT_ALT
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

        map(keyCodes.SHIFT, ATOM.CTRL);
        map(keyCodes.SHIFT_LEFT, ATOM.CTRL); // using CAPSLOCK for CTRL doesn't work on MAC
        map(keyCodes.CTRL, ATOM.SHIFT);
        map(keyCodes.CTRL_LEFT, ATOM.SHIFT);

        map(keyCodes.CTRL_RIGHT, ATOM.SHIFT);
        map(keyCodes.SHIFT_RIGHT, ATOM.REPT);

        // A-L normal
        map(keyCodes.SEMICOLON, ATOM.SEMICOLON_PLUS); // ; / +
        map(keyCodes.APOSTROPHE, ATOM.LEFT_SQUARE_BRACKET);
        map(keyCodes.BACKSLASH, ATOM.RIGHT_SQUARE_BRACKET); // HASH is \| key on Mac

        // Z - M normal
    }

    // user keymapping
    // do last (to override defaults)
    while (userKeymap.length > 0) {
        var mapping = userKeymap.pop();
        map(keyCodes[mapping.native], ATOM[mapping.atom]);
    }

    return keys2;
}

export function remapGamepad(gamepad) {
    //mmcdefaults

    // 3-key pressed    left
    // G-key pressed    right
    // Q-key pressed    up
    // =-key pressed    down
    // rightarrow-key pressed   fire

    gamepad.gamepadMapping[14] = ATOM.K3;
    gamepad.gamepadMapping[15] = ATOM.G;
    gamepad.gamepadMapping[13] = ATOM.MINUS_EQUALS;
    gamepad.gamepadMapping[12] = ATOM.Q;

    // often <Return> = "Fire"
    gamepad.gamepadMapping[0] = ATOM.RIGHT;
    // "start" (often <Space> to start game)
    gamepad.gamepadMapping[9] = ATOM.SPACE;
}

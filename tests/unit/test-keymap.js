import { afterEach, describe, expect, it, vi } from "vitest";

import { ATOM, atomKeyForCharacter, getKeyMapAtom } from "../../src/keymap-atom.js";
import {
    BBC,
    bbcKeyForCharacter,
    getKeyMap,
    hostKeyCodes,
    keyCodes,
    ShiftOverride,
    stringToBBCKeys,
    userKeymap,
} from "../../src/keymap.js";
import { processInputParams } from "../../src/web/parameters.js";

describe("Keyboard mapping", function () {
    it("maps simple strings to BBC keys correctly", function () {
        expect(stringToBBCKeys("\n\t ")).toEqual([BBC.RETURN, BBC.TAB, BBC.SPACE]);
        expect(stringToBBCKeys("ABC")).toEqual([BBC.A, BBC.B, BBC.C]);
        expect(stringToBBCKeys("123")).toEqual([BBC.K1, BBC.K2, BBC.K3]);
        expect(stringToBBCKeys("a")).toEqual([BBC.CAPSLOCK, BBC.A, BBC.CAPSLOCK]);
        expect(stringToBBCKeys("!")).toEqual([BBC.SHIFT, BBC.K1, BBC.SHIFT]);
    });
});

describe("User key mapping from KEY. URL parameters", function () {
    afterEach(function () {
        userKeymap.length = 0;
    });

    const applyParams = (params, machineKeys) =>
        processInputParams(params, { machineKeys, hostKeyCodes, userKeymap, gamepad: { remap: () => null } });

    it("overrides the default binding for the host key", function () {
        expect(getKeyMap("physical")[false][keyCodes.ENTER]).toEqual(BBC.RETURN);

        applyParams({ "KEY.ENTER": "COPY" }, BBC);

        const keyMap = getKeyMap("physical");
        expect(keyMap[false][keyCodes.ENTER]).toEqual(BBC.COPY);
        expect(keyMap[true][keyCodes.ENTER]).toEqual(BBC.COPY);
    });

    it("applies to the Atom, whose key names differ from the BBC's", function () {
        applyParams({ "KEY.ENTER": "LOCK" }, ATOM);

        expect(getKeyMapAtom("physical")[false][keyCodes.ENTER]).toEqual(ATOM.LOCK);
    });

    it("maps both sides at once for a host key name that names a pair", function () {
        applyParams({ "KEY.SHIFT": "COPY" }, BBC);

        const keyMap = getKeyMap("physical");
        expect(keyMap[false][keyCodes.SHIFT_LEFT]).toEqual(BBC.COPY);
        expect(keyMap[false][keyCodes.SHIFT_RIGHT]).toEqual(BBC.COPY);
    });

    it("still knows HASH as a name for the key a US keyboard prints as backslash", function () {
        applyParams({ "KEY.HASH": "COPY" }, BBC);

        expect(getKeyMap("physical")[false][keyCodes.BACKSLASH]).toEqual(BBC.COPY);
    });

    it("still knows CLEAR, which an Apple keyboard prints where a PC says num lock", function () {
        applyParams({ "KEY.CLEAR": "COPY" }, BBC);

        expect(getKeyMap("physical")[false][keyCodes.NUMLOCK]).toEqual(BBC.COPY);
    });

    it("binds a host key no layout uses by default", function () {
        applyParams({ "KEY.WINDOWS_RIGHT": "SHIFTLOCK" }, BBC);

        expect(getKeyMap("physical")[false][keyCodes.WINDOWS_RIGHT]).toEqual(BBC.SHIFTLOCK);
    });

    it("ignores unknown host and machine key names", function () {
        // RETURN is the BBC's name for the key the host calls ENTER: not a host key name.
        const warnings = applyParams({ "KEY.RETURN": "COPY", "KEY.ENTER": "NOTAKEY" }, BBC);

        expect(warnings).toHaveLength(2);
        expect(userKeymap).toEqual([]);
        expect(getKeyMap("physical")[false][keyCodes.ENTER]).toEqual(BBC.RETURN);
    });
});

describe.each([
    {
        machine: "BBC",
        keyFor: bbcKeyForCharacter,
        shifted: {
            "!": { key: BBC.K1, shift: true, upperCase: true },
            "*": { key: BBC.COLON_STAR, shift: true, upperCase: true },
            "?": { key: BBC.SLASH, shift: true, upperCase: true },
        },
        unshifted: {
            "@": { key: BBC.AT, shift: false, upperCase: true },
            "^": { key: BBC.HAT_TILDE, shift: false, upperCase: true },
            ":": { key: BBC.COLON_STAR, shift: false, upperCase: true },
        },
        unprintable: ["`", "\u00e9"],
    },
    {
        machine: "Atom",
        keyFor: atomKeyForCharacter,
        shifted: {
            "!": { key: ATOM.K1, shift: true },
            "=": { key: ATOM.MINUS_EQUALS, shift: true },
            "|": { key: ATOM.BACKSLASH, shift: true },
        },
        unshifted: {
            "@": { key: ATOM.AT, shift: false },
            "^": { key: ATOM.UP_ARROW, shift: false },
            ":": { key: ATOM.COLON_STAR, shift: false },
        },
        unprintable: ["_", "\u00a3"],
    },
])("How a $machine keyboard types a character", function ({ machine, keyFor, shifted, unshifted, unprintable }) {
    it("puts the shifted characters on their unshifted key", function () {
        for (const [char, expected] of Object.entries(shifted)) expect(keyFor(char)).toEqual(expected);
    });

    it(`knows the characters the ${machine} prints without shift, where a PC needs it`, function () {
        for (const [char, expected] of Object.entries(unshifted)) expect(keyFor(char)).toEqual(expected);
    });

    it(`has nothing for a character the ${machine} cannot print`, function () {
        for (const char of unprintable) expect(keyFor(char)).toBeNull();
    });
});

describe("Building a key map", function () {
    afterEach(function () {
        vi.restoreAllMocks();
    });

    it.each([
        ["BBC", getKeyMap],
        ["Atom", getKeyMapAtom],
    ])("binds each host key once in every layout of the %s", function (_machine, build) {
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        for (const layout of ["physical", "gaming", "natural"]) build(layout);
        expect(log).not.toHaveBeenCalled();
    });
});

describe("How the BBC alone types a character", function () {
    it("asks for the caps lock the other way round for lower case", function () {
        expect(bbcKeyForCharacter("A")).toEqual({ key: BBC.A, shift: false, upperCase: true });
        expect(bbcKeyForCharacter("a")).toEqual({ key: BBC.A, shift: false, upperCase: false });
    });

    it("puts the pound sign on shift and the underscore key, where the BBC draws it", function () {
        expect(bbcKeyForCharacter("\u00a3")).toEqual({ key: BBC.UNDERSCORE_POUND, shift: true, upperCase: true });
    });
});

describe("How the Atom alone types a character", function () {
    it("asks for the lock only for letters", function () {
        expect(atomKeyForCharacter("A")).toEqual({ key: ATOM.A, shift: false, upperCase: true });
        expect(atomKeyForCharacter("a")).toEqual({ key: ATOM.A, shift: false, upperCase: false });
        expect(atomKeyForCharacter("1")).toEqual({ key: ATOM.K1, shift: false });
    });
});

describe("The BBC's natural key map", function () {
    it("holds the BBC's shift its own way where it disagrees with the host's", function () {
        const keyMap = getKeyMap("natural");
        expect(keyMap[true]["^"]).toEqual([...BBC.HAT_TILDE, false]);
        expect(keyMap[false]['"']).toEqual([...BBC.K2, true]);
        expect(keyMap[true]['"']).toEqual(BBC.K2);
        expect(keyMap[false]["6"]).toEqual(BBC.K6);
        expect(keyMap[true][" "]).toEqual(BBC.SPACE);
    });
});

describe("The Atom's key map", function () {
    const Letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    it("keys the natural layout by the character the host produced, in either case", function () {
        const keyMap = getKeyMapAtom("natural");
        for (const shiftDown of [false, true]) {
            for (const letter of Letters) {
                expect(keyMap[shiftDown][letter]).toEqual(ATOM[letter]);
                expect(keyMap[shiftDown][letter.toLowerCase()]).toEqual(ATOM[letter]);
            }
        }
        expect(keyMap[false]["2"]).toEqual(ATOM.K2);
    });

    it("holds the Atom's shift its own way where it disagrees with the host's", function () {
        const keyMap = getKeyMapAtom("natural");
        // US: shift and 2 for `@`, which the Atom prints without shift.
        expect(keyMap[true]["@"]).toEqual([...ATOM.AT, false]);
        expect(keyMap[false]["@"]).toEqual(ATOM.AT);
        // US: `=` has a key of its own, where the Atom shifts `-`.
        expect(keyMap[false]["="]).toEqual([...ATOM.MINUS_EQUALS, true]);
        expect(keyMap[true]["="]).toEqual(ATOM.MINUS_EQUALS);
    });

    it("leaves the host's shift alone on space", function () {
        const keyMap = getKeyMapAtom("natural");
        expect(keyMap[true][" "]).toEqual(ATOM.SPACE);
        expect(keyMap[false][" "]).toEqual(ATOM.SPACE);
    });

    it("puts the host's caps lock on the Atom's lock in the natural layout", function () {
        expect(getKeyMapAtom("natural")[false][keyCodes.CAPSLOCK]).toEqual(ATOM.LOCK);
    });

    it("gives every letter its own key in each layout", function () {
        for (const layout of ["physical", "gaming", "natural"]) {
            const keyMap = getKeyMapAtom(layout);
            for (const letter of Letters) expect(keyMap[false][`Key${letter}`]).toEqual(ATOM[letter]);
        }
    });

    it("keeps the physical layout where a real Atom has its keys", function () {
        const keyMap = getKeyMapAtom("physical");
        expect(keyMap[false][keyCodes.K2]).toEqual(ATOM.K2);
        expect(keyMap[false][keyCodes.EQUALS]).toEqual(ATOM.COLON_STAR);
        expect(keyMap[false][keyCodes.LEFT_SQUARE_BRACKET]).toEqual(ATOM.AT);
        expect(keyMap[false][keyCodes.SHIFT_LEFT]).toEqual(ATOM.CTRL);
    });

    it("keeps the gaming layout's digits and caps lock", function () {
        const keyMap = getKeyMapAtom("gaming");
        expect(keyMap[false][keyCodes.K0]).toEqual(ATOM.K0);
        expect(keyMap[false][keyCodes.CAPSLOCK]).toEqual(ATOM.CTRL);
    });

    it.each([
        ["physical", [keyCodes.BACKSPACE, keyCodes.DELETE]],
        ["natural", [keyCodes.BACKSPACE, keyCodes.DELETE]],
        ["gaming", [keyCodes.MENU]],
    ])("reaches DELETE in the %s layout", function (layout, codes) {
        const keyMap = getKeyMapAtom(layout);
        for (const code of codes) expect(keyMap[false][code]).toEqual(ATOM.DELETE);
    });
});

describe("ShiftOverride", function () {
    const Shift = [0, 0];
    const Mappings = { S: Shift, P: [1, 0], N: [2, 0, false], Y: [3, 0, true] };

    function makeMatrix() {
        return Object.values(Mappings).map(() => new Uint8Array(1));
    }

    function shiftAfter(shift, keys, step) {
        shift.setMapped(keys, Mappings[step[0]], step[1] === "+" ? 1 : 0);
        return keys[Shift[0]][Shift[1]];
    }

    // Each step is a key (S the shift key, P plain, N and Y forcing SHIFT off and on), + or - for
    // down or up, and the SHIFT the matrix then holds.
    it.each([
        ["follows the shift key", "S+1 P+1 P-1 S-0"],
        ["forces SHIFT off while a key is down, then gives the shift key back", "S+1 N+0 N-1"],
        ["keeps SHIFT forced when the shift key goes first", "S+1 N+0 S-0 N-0"],
        ["holds a forced SHIFT through a plain key", "Y+1 P+1 P-1 Y-0"],
        ["lets the later of two forcing keys win, and its release end the force", "S+1 Y+1 N+0 N-1"],
        ["ends the force on the release of the earlier of two forcing keys too", "S+1 Y+1 N+0 Y-1"],
    ])("%s", function (_, steps) {
        const keys = makeMatrix();
        const shift = new ShiftOverride(Shift);
        for (const step of steps.split(" ")) expect(shiftAfter(shift, keys, step), step).toBe(Number(step[2]));
    });

    it("leaves a SHIFT set on the matrix directly to plain keys", function () {
        const keys = makeMatrix();
        keys[Shift[0]][Shift[1]] = 1;
        expect(shiftAfter(new ShiftOverride(Shift), keys, "P+")).toBe(1);
    });

    it("forgets a forced SHIFT on clear", function () {
        const shift = new ShiftOverride(Shift);
        shiftAfter(shift, makeMatrix(), "Y+");
        shift.clear();
        expect(shiftAfter(shift, makeMatrix(), "P+")).toBe(0);
    });

    it.each([
        ["Y", 1],
        ["N", 0],
    ])("carries the SHIFT %s forces through state and restore", function (forcingKey, forcedShift) {
        const shift = new ShiftOverride(Shift);
        shiftAfter(shift, makeMatrix(), `${forcingKey}+`);
        const carried = new ShiftOverride(Shift);
        carried.restore(shift.state());

        const keys = makeMatrix();
        keys[Shift[0]][Shift[1]] = 1 - forcedShift;
        expect(shiftAfter(carried, keys, "P+")).toBe(forcedShift);
    });
});

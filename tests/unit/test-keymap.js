import { afterEach, describe, expect, it } from "vitest";

import { ATOM, atomKeyForCharacter, getKeyMapAtom } from "../../src/keymap-atom.js";
import {
    BBC,
    bbcKeyForCharacter,
    getKeyMap,
    hostKeyCodes,
    keyCodes,
    stringToBBCKeys,
    userKeymap,
} from "../../src/keymap.js";
import { processInputParams } from "../../src/url-params.js";

describe("Keyboard mapping", function () {
    it("maps simple strings to BBC keys correctly", function () {
        // Test special characters
        const keys1 = stringToBBCKeys("\n\t ");
        expect(keys1).toEqual([BBC.RETURN, BBC.TAB, BBC.SPACE]);

        // Verify uppercase letters are mapped correctly
        expect(stringToBBCKeys("ABC")).toEqual([BBC.A, BBC.B, BBC.C]);

        // Verify numbers are mapped correctly
        expect(stringToBBCKeys("123")).toEqual([BBC.K1, BBC.K2, BBC.K3]);

        // Test that stringToBBCKeys returns expected length for simple inputs
        expect(stringToBBCKeys("Q").length).toBe(1);
        expect(stringToBBCKeys("a").length).toBe(3); // With CAPSLOCK toggles
        expect(stringToBBCKeys("!").length).toBe(3); // With SHIFT
    });
});

describe("What a character costs on a BBC keyboard", function () {
    it("puts the shifted characters on their unshifted key", function () {
        expect(bbcKeyForCharacter("!")).toEqual({ key: BBC.K1, shift: true, upperCase: true });
        expect(bbcKeyForCharacter("*")).toEqual({ key: BBC.COLON_STAR, shift: true, upperCase: true });
        expect(bbcKeyForCharacter("?")).toEqual({ key: BBC.SLASH, shift: true, upperCase: true });
    });

    it("knows the characters the BBC prints without shift, where a PC needs it", function () {
        expect(bbcKeyForCharacter("@")).toEqual({ key: BBC.AT, shift: false, upperCase: true });
        expect(bbcKeyForCharacter("^")).toEqual({ key: BBC.HAT_TILDE, shift: false, upperCase: true });
        expect(bbcKeyForCharacter(":")).toEqual({ key: BBC.COLON_STAR, shift: false, upperCase: true });
    });

    it("asks for the caps lock the other way round for lower case", function () {
        expect(bbcKeyForCharacter("A")).toEqual({ key: BBC.A, shift: false, upperCase: true });
        expect(bbcKeyForCharacter("a")).toEqual({ key: BBC.A, shift: false, upperCase: false });
    });

    it("puts the pound sign on shift and the underscore key, where the BBC draws it", function () {
        expect(bbcKeyForCharacter("\u00a3")).toEqual({ key: BBC.UNDERSCORE_POUND, shift: true, upperCase: true });
    });

    it("has nothing for a character the BBC cannot print", function () {
        expect(bbcKeyForCharacter("`")).toBeNull();
        expect(bbcKeyForCharacter("\u00e9")).toBeNull();
    });
});

describe("User key mapping from KEY. URL parameters", function () {
    afterEach(function () {
        userKeymap.length = 0;
    });

    const applyParams = (params, machineKeys) =>
        processInputParams(params, machineKeys, hostKeyCodes, userKeymap, { remap: () => null });

    it("overrides the default binding for the host key", function () {
        expect(getKeyMap("physical")[false][keyCodes.ENTER]).toEqual(BBC.RETURN);

        applyParams({ "KEY.ENTER": "COPY" }, BBC);

        const keyMap = getKeyMap("physical");
        expect(keyMap[false][keyCodes.ENTER]).toEqual(BBC.COPY);
        expect(keyMap[true][keyCodes.ENTER]).toEqual(BBC.COPY);
    });

    it("survives the key map being rebuilt, as on a layout or model change", function () {
        applyParams({ "KEY.ENTER": "COPY" }, BBC);

        getKeyMap("physical");
        expect(getKeyMap("physical")[false][keyCodes.ENTER]).toEqual(BBC.COPY);
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

describe("What a character costs on an Atom keyboard", function () {
    it("puts the shifted characters on their unshifted key", function () {
        expect(atomKeyForCharacter("!")).toEqual({ key: ATOM.K1, shift: true });
        expect(atomKeyForCharacter("=")).toEqual({ key: ATOM.MINUS_EQUALS, shift: true });
        expect(atomKeyForCharacter("|")).toEqual({ key: ATOM.BACKSLASH, shift: true });
    });

    it("knows the characters the Atom prints without shift, where a PC needs it", function () {
        expect(atomKeyForCharacter("@")).toEqual({ key: ATOM.AT, shift: false });
        expect(atomKeyForCharacter("^")).toEqual({ key: ATOM.UP_ARROW, shift: false });
        expect(atomKeyForCharacter(":")).toEqual({ key: ATOM.COLON_STAR, shift: false });
    });

    it("asks for the lock only for letters", function () {
        expect(atomKeyForCharacter("A")).toEqual({ key: ATOM.A, shift: false, upperCase: true });
        expect(atomKeyForCharacter("a")).toEqual({ key: ATOM.A, shift: false, upperCase: false });
        expect(atomKeyForCharacter("1")).toEqual({ key: ATOM.K1, shift: false });
    });

    it("has nothing for a character the Atom cannot print", function () {
        expect(atomKeyForCharacter("_")).toBeNull();
        expect(atomKeyForCharacter("\u00a3")).toBeNull();
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
});

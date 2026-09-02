import { afterEach, describe, expect, it } from "vitest";

import { ATOM, getKeyMapAtom } from "../../src/keymap-atom.js";
import { BBC, getKeyMap, keyCodes, stringToBBCKeys, userKeymap } from "../../src/keymap.js";
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

describe("User key mapping from KEY. URL parameters", function () {
    afterEach(function () {
        userKeymap.length = 0;
    });

    const applyParams = (params, machineKeys) =>
        processInputParams(params, machineKeys, keyCodes, userKeymap, { remap: () => null });

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

    it("ignores unknown host and machine key names", function () {
        // RETURN is the BBC's name for the key the host calls ENTER: not a host key name.
        const warnings = applyParams({ "KEY.RETURN": "COPY", "KEY.ENTER": "NOTAKEY" }, BBC);

        expect(warnings).toHaveLength(2);
        expect(userKeymap).toEqual([]);
        expect(getKeyMap("physical")[false][keyCodes.ENTER]).toEqual(BBC.RETURN);
    });
});

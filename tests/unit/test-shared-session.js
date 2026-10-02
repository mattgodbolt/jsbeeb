// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { sessionInput } from "../../src/web/shared-session.js";

// A layout in which "a" is at [4, 1], and "@" is the same key with BBC SHIFT forced up.
const sysvia = {
    keyMapping: (key, shiftDown) => ({ a: [4, 1], "@": shiftDown ? [4, 1, false] : undefined })[key],
};

function sent(allowBreak, act) {
    const inputs = [];
    act(sessionInput(sysvia, (input) => inputs.push(input), { allowBreak }));
    return inputs;
}

describe("sessionInput", () => {
    it("sends a key as its place on the matrix, with no SHIFT override when it has none", () => {
        expect(sent(false, (input) => input.keyDown("a", false))).toEqual([
            { kind: "key", mapping: [4, 1], down: true },
        ]);
    });

    it("lets a key go under each of its mappings, as the machine's own keyUp does", () => {
        expect(sent(false, (input) => input.keyUp("@"))).toEqual([
            { kind: "key", mapping: [4, 1, false], down: false },
        ]);
        expect(sent(false, (input) => input.keyUp("a"))).toEqual([
            { kind: "key", mapping: [4, 1], down: false },
            { kind: "key", mapping: [4, 1], down: false },
        ]);
    });

    it("sends nothing for a key the layout does not have", () => {
        expect(sent(false, (input) => input.keyDown("?", false))).toEqual([]);
    });

    it("sends BREAK only where it is allowed", () => {
        expect(sent(true, (input) => input.setReset(true))).toEqual([{ kind: "break", down: true }]);
        expect(sent(false, (input) => input.setReset(true))).toEqual([]);
    });
});

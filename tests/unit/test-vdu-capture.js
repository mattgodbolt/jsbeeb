import { describe, expect, it } from "vitest";

import { VduTextCapture } from "../../src/vdu-capture.js";

describe("VduTextCapture", () => {
    const capture = (options) => {
        const elements = [];
        const decoder = new VduTextCapture((element) => elements.push(element), options);
        const send = (...bytes) => {
            for (const byte of bytes) decoder.onChar(typeof byte === "string" ? byte.charCodeAt(0) : byte);
        };
        return { decoder, elements, send, text: (s) => send(...s) };
    };

    it("emits a line of text where the cursor was when a newline arrives", () => {
        const { elements, text, send } = capture();
        text("HELLO");
        send(13, 10);
        expect(elements).toEqual([{ x: 0, y: 0, text: "HELLO", foreground: 7, background: 0, mode: 7 }]);
        text("WORLD");
        send(13, 10);
        expect(elements[1]).toMatchObject({ x: 0, y: 1, text: "WORLD" });
    });

    it("hands out copies, so later output cannot change an earlier element", () => {
        const { elements, text, send } = capture();
        text("A");
        send(10);
        text("B");
        send(10);
        expect(elements[0].y).toBe(0);
    });

    it("follows TAB, COLOUR and MODE, and MODE resets the colours", () => {
        const { elements, text, send } = capture();
        send(31, 5, 3, 17, 2, 17, 0x81);
        text("HI");
        send(22, 1);
        expect(elements).toEqual([{ x: 5, y: 3, text: "HI", foreground: 2, background: 1, mode: 7 }]);
        text("X");
        send(10);
        expect(elements[1]).toMatchObject({ x: 0, y: 0, mode: 1, foreground: 7, background: 0 });
    });

    it("swallows the parameters of the other VDU sequences", () => {
        const { elements, text, send } = capture();
        send(19, 1, 2, 3, 4, 5, 25, 4, 0, 0, 0, 0, 1, 65);
        text("OK");
        send(10);
        expect(elements.map((e) => e.text)).toEqual(["OK"]);
    });

    it("treats every byte as a character on the Atom, which has no such sequences", () => {
        const { elements, send } = capture({ isAtom: true });
        send(31, 65, 66, 10);
        expect(elements.map((e) => e.text)).toEqual(["AB"]);
    });

    it("carries its cursor through a snapshot, dropping a half-read sequence", () => {
        const { decoder, elements, text, send } = capture();
        text("AB");
        send(31, 4);
        const state = decoder.snapshot();
        const other = new VduTextCapture((element) => elements.push(element));
        other.restore(state);
        other.onChar(9);
        other.onChar(67);
        other.onChar(10);
        // AB was flushed when the TAB began; the TAB itself is lost, so C follows on.
        expect(elements.map(({ x, y, text }) => ({ x, y, text }))).toEqual([
            { x: 0, y: 0, text: "AB" },
            { x: 2, y: 0, text: "C" },
        ]);
    });

    it("flushes text that no control code has terminated yet", () => {
        const { decoder, elements, text } = capture();
        text("PROMPT>");
        expect(elements).toEqual([]);
        decoder.flush();
        expect(elements.map((e) => e.text)).toEqual(["PROMPT>"]);
    });
});

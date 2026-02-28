import { describe, it, expect, beforeEach, vi } from "vitest";
import { SpeechOutput, MAX_BUFFER } from "../../src/speech-output.js";

// Stub out speechSynthesis so tests run in Node without a browser.
const mockSpeak = vi.fn();
const mockCancel = vi.fn();
global.speechSynthesis = { speak: mockSpeak, cancel: mockCancel };
global.SpeechSynthesisUtterance = class {
    constructor(text) {
        this.text = text;
    }
};

describe("SpeechOutput", () => {
    let speech;

    beforeEach(() => {
        speech = new SpeechOutput();
        speech.enabled = true;
        mockSpeak.mockClear();
        mockCancel.mockClear();
    });

    it("tryReceive always returns -1", () => {
        expect(speech.tryReceive()).toBe(-1);
        expect(speech.tryReceive(true)).toBe(-1);
    });

    it("speaks buffered text on CR", () => {
        for (const ch of "HELLO") speech.onTransmit(ch.charCodeAt(0));
        expect(mockSpeak).not.toHaveBeenCalled();
        speech.onTransmit(13); // CR
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("HELLO");
    });

    it("does NOT flush on LF (LF is null data per Votrax spec)", () => {
        for (const ch of "WORLD") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(10); // LF — null data, must not trigger speech
        expect(mockSpeak).not.toHaveBeenCalled();
        speech.onTransmit(13); // CR — the real flush trigger
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("WORLD");
    });

    it("does nothing when disabled", () => {
        speech.enabled = false;
        for (const ch of "TEST") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockSpeak).not.toHaveBeenCalled();
    });

    it("cancels speech and clears buffer when disabled mid-buffer", () => {
        for (const ch of "PARTIAL") speech.onTransmit(ch.charCodeAt(0));
        speech.enabled = false;
        expect(mockCancel).toHaveBeenCalled();
        speech.enabled = true;
        speech.onTransmit(13);
        expect(mockSpeak).not.toHaveBeenCalled(); // buffer was cleared
    });

    it("ignores non-printable bytes (< 0x20) other than CR, BS, ESC", () => {
        // Per Votrax manual: non-printable bytes that aren't specified commands
        // are null data and are ignored.  This means BBC VDU codes, BEL,
        // LF, etc. are all silently dropped.
        speech.onTransmit(7); // BEL
        speech.onTransmit(22); // VDU 22 (MODE)
        speech.onTransmit(7); // would-be VDU param byte — treated as null data, not VDU
        for (const ch of "DING") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockSpeak.mock.calls[0][0].text).toBe("DING");
    });

    it("handles BS (0x08) — deletes last character from buffer", () => {
        for (const ch of "HI!") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(0x08); // delete "!"
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("HI");
    });

    it("handles ESC (0x1B) — next byte is a mode control, not text", () => {
        for (const ch of "TEST") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(0x1b); // ESC
        speech.onTransmit(0x11); // DC1 = PSEND ON — consumed as mode code
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("TEST");
    });

    it("ignores DEL (127) and high bytes", () => {
        speech.onTransmit(127);
        speech.onTransmit(200);
        for (const ch of "HI") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockSpeak.mock.calls[0][0].text).toBe("HI");
    });

    it("cancels in-progress speech before starting new utterance", () => {
        for (const ch of "ONE") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        for (const ch of "TWO") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockCancel).toHaveBeenCalledTimes(2);
        expect(mockSpeak).toHaveBeenCalledTimes(2);
    });

    it("auto-speaks when input buffer reaches MAX_BUFFER bytes (buffer-full condition)", () => {
        // The Votrax manual says "input buffer full" is a TALK-CLR trigger.
        // Our MAX_BUFFER is 128 bytes.
        const longText = "A".repeat(MAX_BUFFER);
        for (const ch of longText) speech.onTransmit(ch.charCodeAt(0));
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe(longText);
    });
});

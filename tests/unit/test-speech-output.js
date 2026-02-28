import { describe, it, expect, beforeEach, vi } from "vitest";
import { SpeechOutput } from "../../src/speech-output.js";

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

    it("speaks buffered text on LF", () => {
        for (const ch of "WORLD") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(10); // LF
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

    it("strips VDU 22 (MODE change) and its one parameter byte", () => {
        speech.onTransmit(22); // VDU 22 — MODE
        speech.onTransmit(7); // parameter byte — should be swallowed
        for (const ch of "TEXT") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockSpeak.mock.calls[0][0].text).toBe("TEXT");
    });

    it("strips VDU 31 (cursor position) and its two parameter bytes", () => {
        speech.onTransmit(31); // VDU 31
        speech.onTransmit(10); // X param — must not trigger LF flush
        speech.onTransmit(5); // Y param
        for (const ch of "OK") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockSpeak.mock.calls[0][0].text).toBe("OK");
    });

    it("strips VDU 23 (program character) and its nine parameter bytes", () => {
        speech.onTransmit(23);
        for (let i = 0; i < 9; i++) speech.onTransmit(0xff);
        for (const ch of "AFTER") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockSpeak.mock.calls[0][0].text).toBe("AFTER");
    });

    it("ignores other control codes (< 32) without swallowing extra bytes", () => {
        speech.onTransmit(7); // BEL — 0 params, ignored
        for (const ch of "DING") speech.onTransmit(ch.charCodeAt(0));
        speech.onTransmit(13);
        expect(mockSpeak.mock.calls[0][0].text).toBe("DING");
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

    it("safety-flushes after 200 characters without a newline", () => {
        const longText = "A".repeat(200);
        for (const ch of longText) speech.onTransmit(ch.charCodeAt(0));
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe(longText);
    });
});

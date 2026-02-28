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

function transmit(speech, str) {
    for (const ch of str) speech.onTransmit(ch.charCodeAt(0));
}

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
    });

    it("speaks buffered text on CR", () => {
        transmit(speech, "HELLO");
        expect(mockSpeak).not.toHaveBeenCalled();
        speech.onTransmit(0x0d);
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("HELLO");
    });

    it("multiple CR-terminated lines queue without cancelling each other", () => {
        transmit(speech, "Welcome to the castle.");
        speech.onTransmit(0x0d);
        transmit(speech, "There is a sword here.");
        speech.onTransmit(0x0d);
        transmit(speech, "What now?");
        speech.onTransmit(0x0d);

        expect(mockSpeak).toHaveBeenCalledTimes(3);
        expect(mockCancel).not.toHaveBeenCalled();
        expect(mockSpeak.mock.calls[0][0].text).toBe("Welcome to the castle.");
        expect(mockSpeak.mock.calls[1][0].text).toBe("There is a sword here.");
        expect(mockSpeak.mock.calls[2][0].text).toBe("What now?");
    });

    it("LF is null data — ignored", () => {
        transmit(speech, "WORLD");
        speech.onTransmit(0x0a); // LF — ignored
        expect(mockSpeak).not.toHaveBeenCalled();
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("WORLD");
    });

    it("does nothing when disabled", () => {
        speech.enabled = false;
        transmit(speech, "TEST");
        speech.onTransmit(0x0d);
        expect(mockSpeak).not.toHaveBeenCalled();
    });

    it("cancels speech and clears buffer when disabled", () => {
        transmit(speech, "PARTIAL");
        speech.enabled = false;
        expect(mockCancel).toHaveBeenCalled();
        speech.enabled = true;
        speech.onTransmit(0x0d);
        expect(mockSpeak).not.toHaveBeenCalled();
    });

    it("ignores non-printable bytes other than CR and ESC", () => {
        speech.onTransmit(7); // BEL — null data
        speech.onTransmit(22); // VDU 22 — null data
        transmit(speech, "DING");
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("DING");
    });

    it("BS (0x08) is null data — ignored", () => {
        // The TNT manual lists only CR, LF, and ESC as defined commands.
        transmit(speech, "HI!");
        speech.onTransmit(0x08);
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("HI!");
    });

    it("ESC consumes the following byte silently (unit-select, TNT manual)", () => {
        transmit(speech, "TEST");
        speech.onTransmit(0x1b); // ESC
        speech.onTransmit(0x41); // unit-select byte — consumed
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("TEST");
    });

    it("auto-flushes when buffer reaches MAX_BUFFER bytes", () => {
        transmit(speech, "A".repeat(MAX_BUFFER));
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("A".repeat(MAX_BUFFER));
    });
});

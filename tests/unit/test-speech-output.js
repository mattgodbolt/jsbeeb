import { describe, it, expect, beforeEach, vi } from "vitest";
import { SpeechOutput, MAX_BUFFER, NEW_RESPONSE_GAP_MS } from "../../src/speech-output.js";

// Stub out speechSynthesis so tests run in Node without a browser.
const mockSpeak = vi.fn();
const mockCancel = vi.fn();
global.speechSynthesis = { speak: mockSpeak, cancel: mockCancel };
global.SpeechSynthesisUtterance = class {
    constructor(text) {
        this.text = text;
    }
};

// Helper: send an ASCII string byte-by-byte.
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
        expect(speech.tryReceive(true)).toBe(-1);
    });

    it("speaks buffered text immediately on CR", () => {
        transmit(speech, "HELLO");
        expect(mockSpeak).not.toHaveBeenCalled();
        speech.onTransmit(0x0d); // CR
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("HELLO");
    });

    it("multiple CRs queue separate utterances without cancelling", () => {
        // Simulates a text adventure room description: several lines in rapid
        // succession.  Each should be queued and played in order, not cancelled.
        transmit(speech, "Welcome to the castle.");
        speech.onTransmit(0x0d);
        transmit(speech, "There is a sword here.");
        speech.onTransmit(0x0d);
        transmit(speech, "What now?");
        speech.onTransmit(0x0d);

        expect(mockSpeak).toHaveBeenCalledTimes(3);
        expect(mockCancel).not.toHaveBeenCalled(); // lines must not cancel each other
        expect(mockSpeak.mock.calls[0][0].text).toBe("Welcome to the castle.");
        expect(mockSpeak.mock.calls[1][0].text).toBe("There is a sword here.");
        expect(mockSpeak.mock.calls[2][0].text).toBe("What now?");
    });

    it("cancels stale speech when new output arrives after a long gap", () => {
        // Simulate: first response spoken, player types (long gap), new response.
        const nowSpy = vi.spyOn(Date, "now");
        nowSpy.mockReturnValue(1000);
        transmit(speech, "First response.");
        speech.onTransmit(0x0d);
        expect(mockCancel).not.toHaveBeenCalled();

        // Long gap — player typed a command.
        nowSpy.mockReturnValue(1000 + NEW_RESPONSE_GAP_MS + 1);
        transmit(speech, "Second response.");
        speech.onTransmit(0x0d);

        expect(mockCancel).toHaveBeenCalled(); // stale speech cancelled
        expect(mockSpeak).toHaveBeenCalledTimes(2);
        nowSpy.mockRestore();
    });

    it("does NOT cancel between lines of the same response (short gap)", () => {
        const nowSpy = vi.spyOn(Date, "now");
        nowSpy.mockReturnValue(1000);
        transmit(speech, "Line one.");
        speech.onTransmit(0x0d);

        nowSpy.mockReturnValue(1001); // 1 ms later — same response burst
        transmit(speech, "Line two.");
        speech.onTransmit(0x0d);

        expect(mockCancel).not.toHaveBeenCalled();
        expect(mockSpeak).toHaveBeenCalledTimes(2);
        nowSpy.mockRestore();
    });

    it("LF alone does not trigger speech", () => {
        speech.onTransmit(0x0a); // LF — null data
        expect(mockSpeak).not.toHaveBeenCalled();
    });

    it("LF within text output is ignored — text still spoken on CR", () => {
        transmit(speech, "WORLD");
        speech.onTransmit(0x0a); // LF — ignored
        expect(mockSpeak).not.toHaveBeenCalled();
        speech.onTransmit(0x0d); // CR — speaks
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("WORLD");
    });

    it("does nothing when disabled", () => {
        speech.enabled = false;
        transmit(speech, "TEST");
        speech.onTransmit(0x0d);
        expect(mockSpeak).not.toHaveBeenCalled();
    });

    it("cancels speech and clears buffer when disabled mid-buffer", () => {
        transmit(speech, "PARTIAL");
        speech.enabled = false;
        expect(mockCancel).toHaveBeenCalled();
        speech.enabled = true;
        speech.onTransmit(0x0d);
        expect(mockSpeak).not.toHaveBeenCalled(); // buffer was cleared
    });

    it("ignores non-printable bytes (< 0x20) other than CR and ESC", () => {
        speech.onTransmit(7); // BEL — null data
        speech.onTransmit(22); // VDU 22 — null data
        transmit(speech, "DING");
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("DING");
    });

    it("BS (0x08) is null data — ignored, does not modify buffer", () => {
        // The TNT manual lists only CR, LF, and ESC as defined commands.
        // All other control codes including BS are null data and are ignored.
        transmit(speech, "HI!");
        speech.onTransmit(0x08); // BS — null data, must not delete "!"
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("HI!");
    });

    it("ESC (0x1B) — next byte is a unit-select code and is consumed silently", () => {
        // TNT manual: ESC introduces a unit-select byte for daisy-chained units.
        // Neither the ESC nor the following byte should appear in speech output.
        transmit(speech, "TEST");
        speech.onTransmit(0x1b); // ESC
        speech.onTransmit(0x41); // 'A' — unit-select byte, consumed silently
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("TEST");
    });

    it("ignores DEL (127) and high bytes", () => {
        speech.onTransmit(127);
        speech.onTransmit(200);
        transmit(speech, "HI");
        speech.onTransmit(0x0d);
        expect(mockSpeak.mock.calls[0][0].text).toBe("HI");
    });

    it("auto-speaks immediately when buffer reaches MAX_BUFFER bytes", () => {
        const longText = "A".repeat(MAX_BUFFER);
        transmit(speech, longText);
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe(longText);
    });
});

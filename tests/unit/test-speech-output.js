import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpeechOutput, MAX_BUFFER, FLUSH_DELAY_MS } from "../../src/speech-output.js";

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
        vi.useFakeTimers();
        speech = new SpeechOutput();
        speech.enabled = true;
        mockSpeak.mockClear();
        mockCancel.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("tryReceive always returns -1", () => {
        expect(speech.tryReceive()).toBe(-1);
        expect(speech.tryReceive(true)).toBe(-1);
    });

    it("speaks buffered text after flush delay (not immediately)", () => {
        transmit(speech, "HELLO");
        expect(mockSpeak).not.toHaveBeenCalled();
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("HELLO");
    });

    it("CR schedules flush but does not speak immediately", () => {
        transmit(speech, "HELLO");
        speech.onTransmit(0x0d); // CR
        expect(mockSpeak).not.toHaveBeenCalled(); // not yet
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak).toHaveBeenCalledOnce();
    });

    it("multiple CRs in rapid succession accumulate into one utterance", () => {
        // Simulates a text adventure room description: several lines printed
        // quickly, each ending in CR.  All should be spoken as one utterance.
        transmit(speech, "Welcome to the castle.");
        speech.onTransmit(0x0d);
        transmit(speech, "There is a sword here.");
        speech.onTransmit(0x0d);
        transmit(speech, "What now?");
        speech.onTransmit(0x0d);

        // Nothing spoken yet — all within the flush window.
        expect(mockSpeak).not.toHaveBeenCalled();

        vi.advanceTimersByTime(FLUSH_DELAY_MS);

        expect(mockSpeak).toHaveBeenCalledOnce();
        const spoken = mockSpeak.mock.calls[0][0].text;
        // All three lines should be present, separated by spaces.
        expect(spoken).toContain("Welcome to the castle.");
        expect(spoken).toContain("There is a sword here.");
        expect(spoken).toContain("What now?");
    });

    it("LF alone does not schedule flush (it is null data)", () => {
        // With no printable text in the buffer, LF should not start a timer.
        speech.onTransmit(0x0a); // LF only
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak).not.toHaveBeenCalled();
    });

    it("LF within text output is ignored — text still spoken after delay", () => {
        transmit(speech, "WORLD");
        speech.onTransmit(0x0a); // LF — ignored, timer still runs from "WORLD"
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("WORLD");
    });

    it("does nothing when disabled", () => {
        speech.enabled = false;
        transmit(speech, "TEST");
        speech.onTransmit(0x0d);
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak).not.toHaveBeenCalled();
    });

    it("cancels speech and clears buffer when disabled mid-buffer", () => {
        transmit(speech, "PARTIAL");
        speech.enabled = false;
        expect(mockCancel).toHaveBeenCalled();
        speech.enabled = true;
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak).not.toHaveBeenCalled(); // buffer was cleared
    });

    it("ignores non-printable bytes (< 0x20) other than CR, BS, ESC", () => {
        speech.onTransmit(7); // BEL
        speech.onTransmit(22); // VDU 22 (MODE)
        speech.onTransmit(7); // would-be VDU param — treated as null data
        transmit(speech, "DING");
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak.mock.calls[0][0].text).toBe("DING");
    });

    it("BS (0x08) is null data — ignored, does not modify buffer", () => {
        // The TNT manual lists only CR, LF, and ESC as defined commands.
        // All other control codes including BS are null data and are ignored.
        transmit(speech, "HI!");
        speech.onTransmit(0x08); // BS — null data, must not delete "!"
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak.mock.calls[0][0].text).toBe("HI!");
    });

    it("ESC (0x1B) — next byte is a unit-select code and is consumed silently", () => {
        // TNT manual: ESC introduces a unit-select byte for daisy-chained units.
        // Neither the ESC nor the following byte should appear in speech output.
        transmit(speech, "TEST");
        speech.onTransmit(0x1b); // ESC
        speech.onTransmit(0x41); // 'A' — unit-select byte, consumed silently
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak.mock.calls[0][0].text).toBe("TEST");
    });

    it("ignores DEL (127) and high bytes", () => {
        speech.onTransmit(127);
        speech.onTransmit(200);
        transmit(speech, "HI");
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockSpeak.mock.calls[0][0].text).toBe("HI");
    });

    it("cancels in-progress speech when a new burst arrives after a gap", () => {
        // First burst: "ONE"
        transmit(speech, "ONE");
        vi.advanceTimersByTime(FLUSH_DELAY_MS); // timer fires → speaks "ONE"
        expect(mockSpeak).toHaveBeenCalledOnce();

        mockSpeak.mockClear();
        mockCancel.mockClear();

        // Second burst (after gap): "TWO" — should cancel stale "ONE" speech.
        transmit(speech, "TWO");
        vi.advanceTimersByTime(FLUSH_DELAY_MS);
        expect(mockCancel).toHaveBeenCalled(); // stale speech cancelled
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe("TWO");
    });

    it("auto-speaks immediately when buffer reaches MAX_BUFFER bytes", () => {
        const longText = "A".repeat(MAX_BUFFER);
        transmit(speech, longText);
        // Should speak without waiting for the timer.
        expect(mockSpeak).toHaveBeenCalledOnce();
        expect(mockSpeak.mock.calls[0][0].text).toBe(longText);
    });
});

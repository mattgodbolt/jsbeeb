"use strict";

/**
 * RS-423 handler that routes transmitted bytes to the Web Speech API,
 * following the Votrax Type 'N Talk protocol (TNT Operator's Manual, 1981).
 *
 * Protocol summary (from the manual):
 *  - Printable ASCII 0x20–0x7E: accumulated in the input buffer.
 *    (On real hardware only A–Z, a–z, 0–9, and "." produce audible speech;
 *    other printable chars produce silence.  We pass the full buffer to the
 *    browser TTS engine, which handles spaces and punctuation well.)
 *  - CR (0x0D) = TALK-CLR: speak the buffer contents, then clear it.
 *  - BS (0x08): delete the last character from the buffer.
 *  - ESC (0x1B): mode/unit-select prefix — the following byte is consumed
 *    as a control code and not treated as text.
 *  - All other bytes (< 0x20 or > 0x7E, except the above): null data — ignored.
 *  - Buffer-full: auto-speak when the buffer reaches MAX_BUFFER bytes.
 *    (The manual mentions this condition but gives no explicit count.  128 bytes
 *    is a conservative estimate given the TNT's 2 KB of onboard RAM.)
 *  - Timer: after TIMER_MS of inactivity the buffer is spoken automatically,
 *    emulating the TNT's optional TIMER mode ("about 3–4 seconds").
 *
 * Note: LF (0x0A) is NOT a flush trigger on the real TNT — it is null data.
 * Only CR (0x0D) flushes the buffer.
 */
export const MAX_BUFFER = 128;
const TIMER_MS = 3500;

export class SpeechOutput {
    constructor() {
        this._buffer = "";
        this._escapeNext = false;
        this._enabled = false;
        this._timer = null;
    }

    get enabled() {
        return this._enabled;
    }

    set enabled(value) {
        this._enabled = !!value;
        if (!this._enabled) {
            this._cancelTimer();
            this._buffer = "";
            this._cancelSpeech();
        }
    }

    /** RS-423 handler interface: called for each byte the BBC transmits. */
    onTransmit(byte) {
        if (!this._enabled) return;

        // ESC prefix: consume the following byte as a mode/unit-select code.
        if (this._escapeNext) {
            this._escapeNext = false;
            return;
        }

        switch (byte) {
            case 0x1b: // ESC — next byte is a mode control, not text.
                this._escapeNext = true;
                return;

            case 0x0d: // CR = TALK-CLR: speak and clear.
                this._flush();
                return;

            case 0x08: // BS: delete last character from buffer.
                this._buffer = this._buffer.slice(0, -1);
                this._resetTimer();
                return;

            default:
                if (byte >= 0x20 && byte <= 0x7e) {
                    // Printable ASCII — accumulate.
                    this._buffer += String.fromCharCode(byte);
                    if (this._buffer.length >= MAX_BUFFER) {
                        this._flush(); // buffer-full condition
                    } else {
                        this._resetTimer();
                    }
                }
            // Everything else is null data — silently ignored.
        }
    }

    /** RS-423 handler interface: nothing to send back to the BBC. */
    tryReceive() {
        return -1;
    }

    // ------------------------------------------------------------------

    _flush() {
        this._cancelTimer();
        const text = this._buffer.trim();
        this._buffer = "";
        if (!text) return;
        this._speak(text);
    }

    _resetTimer() {
        this._cancelTimer();
        this._timer = setTimeout(() => {
            this._timer = null;
            this._flush();
        }, TIMER_MS);
    }

    _cancelTimer() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    _speak(text) {
        if (typeof speechSynthesis === "undefined") return;
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        speechSynthesis.speak(utterance);
    }

    _cancelSpeech() {
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    }
}

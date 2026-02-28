"use strict";

/**
 * RS-423 handler that routes transmitted bytes to the Web Speech API.
 *
 * BBC programs use *FX3,1 (or *FX3,3) to send OSWRCH output to the RS-423
 * serial port, which on real hardware fed a Votrax Type 'N Talk synthesiser.
 * We intercept at the ACIA hardware boundary and route to speechSynthesis.
 *
 * Byte handling is based on the Votrax Type 'N Talk Operator's Manual (1981):
 *  - Printable ASCII 0x20–0x7E: accumulated into the text buffer.
 *  - CR (0x0D): "TALK-CLR" in the manual — triggers speech and clears the
 *    buffer.  We instead treat it as a word boundary (space appended) and
 *    start a short flush timer, so that rapid multi-line output accumulates
 *    into one utterance rather than each line cancelling the previous.
 *  - LF (0x0A): explicitly listed as null data in the manual; ignored.
 *  - ESC (0x1B): unit-select prefix.  The TNT manual describes daisy-chaining
 *    multiple TNT units on a single serial line; ESC followed by a unit-select
 *    byte routes subsequent text to the addressed unit.  We consume the byte
 *    after ESC silently so it isn't passed to speechSynthesis as text.
 *  - All other bytes (including control codes such as BS): null data, ignored.
 *    The manual lists only CR, LF, and ESC as having defined behaviour; all
 *    other non-printable bytes are explicitly "null data".
 *
 * Speech is triggered when:
 *  - FLUSH_DELAY_MS of silence (no new bytes) elapses — accumulates a whole
 *    burst of output (e.g. a room description) into one utterance.
 *  - Buffer reaches MAX_BUFFER characters (hard safety limit).
 */

// From the TNT Operator's Manual: "The input buffer can hold more than 750
// characters".
export const MAX_BUFFER = 750;

// How long to wait after the last byte before speaking accumulated text.
// Short enough to feel responsive; long enough for a multi-line burst to
// arrive in full before we start speaking.
export const FLUSH_DELAY_MS = 400;

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

        // ESC prefix (unit-select, TNT manual §daisy-chain): consume the
        // following byte silently so it isn't treated as speech text.
        if (this._escapeNext) {
            this._escapeNext = false;
            return;
        }

        switch (byte) {
            case 0x1b: // ESC — next byte is a unit-select code, not text.
                this._escapeNext = true;
                return;

            case 0x0d: // CR — word boundary; schedule flush but don't speak yet.
                if (this._buffer.length > 0 && !this._buffer.endsWith(" ")) {
                    this._buffer += " ";
                }
                this._scheduleFlush();
                return;

            default:
                if (byte >= 0x20 && byte <= 0x7e) {
                    // Printable ASCII — accumulate.
                    this._buffer += String.fromCharCode(byte);
                    if (this._buffer.length >= MAX_BUFFER) {
                        this._flushNow(); // hard buffer-full limit
                    } else {
                        this._scheduleFlush();
                    }
                }
            // All other bytes (LF, BS, control codes, high bytes) are null
            // data per the TNT manual and are silently ignored.
        }
    }

    /** RS-423 handler interface: nothing to send back to the BBC. */
    tryReceive() {
        return -1;
    }

    // ------------------------------------------------------------------

    _scheduleFlush() {
        this._cancelTimer();
        this._timer = setTimeout(() => {
            this._timer = null;
            this._flushNow();
        }, FLUSH_DELAY_MS);
    }

    _cancelTimer() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    _flushNow() {
        this._cancelTimer();
        const text = this._buffer.trim();
        this._buffer = "";
        if (!text) return;
        this._speak(text);
    }

    _speak(text) {
        if (typeof speechSynthesis === "undefined") return;
        // Cancel any in-progress utterance: this is a new burst of output
        // (the timer has fired after a gap in the byte stream), so the
        // previous burst is now stale.
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        speechSynthesis.speak(utterance);
    }

    _cancelSpeech() {
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    }
}

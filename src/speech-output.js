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
 *  - CR (0x0D): "TALK-CLR" in the manual — speaks the current buffer and
 *    clears it.  Each CR-terminated line is queued as a separate utterance;
 *    lines within the same response play in sequence without interruption.
 *  - LF (0x0A): explicitly listed as null data in the manual; ignored.
 *  - ESC (0x1B): unit-select prefix.  The TNT manual describes daisy-chaining
 *    multiple TNT units on a single serial line; ESC followed by a unit-select
 *    byte routes subsequent text to the addressed unit.  We consume the byte
 *    after ESC silently so it isn't passed to speechSynthesis as text.
 *  - All other bytes (including control codes such as BS): null data, ignored.
 *    The manual lists only CR, LF, and ESC as having defined behaviour; all
 *    other non-printable bytes are explicitly "null data".
 *
 * Queuing vs cancellation:
 *  Each CR queues a new utterance without cancelling the previous one, so a
 *  multi-line response (e.g. a text adventure room description) starts
 *  speaking immediately and plays through in order.  If new output arrives
 *  after a gap of NEW_RESPONSE_GAP_MS or more — meaning the player has typed
 *  a command and the game is responding — any queued speech from the previous
 *  response is cancelled so the new response starts without delay.
 */

// From the TNT Operator's Manual: "The input buffer can hold more than 750
// characters".
export const MAX_BUFFER = 750;

// Gap after which new output is treated as a fresh response.  Anything
// longer than a typical inter-line gap (near-zero in emulated time) but
// shorter than the time a player takes to type a command (~1–2 s minimum).
export const NEW_RESPONSE_GAP_MS = 1000;

export class SpeechOutput {
    constructor() {
        this._buffer = "";
        this._escapeNext = false;
        this._enabled = false;
        this._lastSpeakTime = null;
    }

    get enabled() {
        return this._enabled;
    }

    set enabled(value) {
        this._enabled = !!value;
        if (!this._enabled) {
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

            case 0x0d: // CR — TALK-CLR: speak current buffer and clear it.
                this._flushNow();
                return;

            default:
                if (byte >= 0x20 && byte <= 0x7e) {
                    // Printable ASCII — accumulate.
                    this._buffer += String.fromCharCode(byte);
                    if (this._buffer.length >= MAX_BUFFER) {
                        this._flushNow(); // hard buffer-full limit
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

    _flushNow() {
        const text = this._buffer.trim();
        this._buffer = "";
        if (!text) return;
        this._speak(text);
    }

    _speak(text) {
        if (typeof speechSynthesis === "undefined") return;
        const now = Date.now();
        // If this output arrives well after the last line, it's a new response
        // (the player has typed a command).  Cancel any stale queued speech.
        if (this._lastSpeakTime !== null && now - this._lastSpeakTime > NEW_RESPONSE_GAP_MS) {
            speechSynthesis.cancel();
        }
        this._lastSpeakTime = now;
        speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    }

    _cancelSpeech() {
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    }
}

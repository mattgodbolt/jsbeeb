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
 *  - CR (0x0D): "TALK-CLR" — speaks the buffer and clears it.  Multiple CR-
 *    terminated lines queue naturally via speechSynthesis.speak().
 *  - LF (0x0A): explicitly listed as null data in the manual; ignored.
 *  - ESC (0x1B): unit-select prefix for daisy-chained TNT units.  ESC plus
 *    the following byte are consumed silently (not passed to speechSynthesis).
 *  - All other bytes: null data per the manual; ignored.
 */

// From the TNT Operator's Manual: "The input buffer can hold more than 750
// characters".
export const MAX_BUFFER = 750;

export class SpeechOutput {
    constructor() {
        this._buffer = "";
        this._escapeNext = false;
        this._enabled = false;
    }

    get enabled() {
        return this._enabled;
    }

    set enabled(value) {
        this._enabled = !!value;
        if (!this._enabled) {
            this._buffer = "";
            if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
        }
    }

    /** RS-423 handler interface: called for each byte the BBC transmits. */
    onTransmit(byte) {
        if (!this._enabled) return;

        if (this._escapeNext) {
            this._escapeNext = false;
            return;
        }

        switch (byte) {
            case 0x1b: // ESC — next byte is a unit-select code, not text.
                this._escapeNext = true;
                return;

            case 0x0d: // CR — TALK-CLR: speak current buffer and clear it.
                this._flush();
                return;

            default:
                if (byte >= 0x20 && byte <= 0x7e) {
                    this._buffer += String.fromCharCode(byte);
                    if (this._buffer.length >= MAX_BUFFER) this._flush();
                }
            // Everything else is null data — silently ignored.
        }
    }

    /** RS-423 handler interface: nothing to send back to the BBC. */
    tryReceive() {
        return -1;
    }

    _flush() {
        const text = this._buffer.trim();
        this._buffer = "";
        if (!text || typeof speechSynthesis === "undefined") return;
        speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    }
}

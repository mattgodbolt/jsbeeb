"use strict";

// Number of parameter bytes that follow each VDU control code 0–31.
// VDU codes not listed here take 0 parameters.
const VDU_PARAM_COUNT = new Uint8Array(32);
VDU_PARAM_COUNT[1] = 1; // send next char to printer only
VDU_PARAM_COUNT[17] = 1; // set text colour
VDU_PARAM_COUNT[18] = 2; // set graphics colour
VDU_PARAM_COUNT[19] = 5; // define palette entry
VDU_PARAM_COUNT[22] = 1; // select MODE
VDU_PARAM_COUNT[23] = 9; // program character / cursor control
VDU_PARAM_COUNT[24] = 8; // set graphics window
VDU_PARAM_COUNT[25] = 5; // PLOT
VDU_PARAM_COUNT[28] = 4; // set text window
VDU_PARAM_COUNT[29] = 4; // set graphics origin
VDU_PARAM_COUNT[31] = 2; // move text cursor (TAB)

/**
 * RS-423 handler that routes transmitted bytes to the Web Speech API.
 *
 * Wire this up as the ACIA's rs423Handler and enable RS-423 output with
 * *FX3,1 (serial + screen) or *FX3,3 (serial only, screen off).  Each
 * printable run of text is spoken when a CR/LF is received or the buffer
 * fills up.  VDU control sequences (cursor movement, colour, mode changes
 * etc.) are stripped via a simple parameter-counting state machine.
 *
 * The class is a no-op when constructed in a non-browser environment
 * (speechSynthesis unavailable) so it can be imported unconditionally.
 */
export class SpeechOutput {
    constructor() {
        this._buffer = "";
        this._skipBytes = 0;
        this._enabled = false;
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

        // Swallow parameter bytes for multi-byte VDU sequences.
        if (this._skipBytes > 0) {
            this._skipBytes--;
            return;
        }

        if (byte >= 32 && byte <= 126) {
            // Printable ASCII — accumulate.
            this._buffer += String.fromCharCode(byte);
            // Safety flush if buffer grows large (avoids speaking a wall of text).
            if (this._buffer.length >= 200) this._flush();
        } else if (byte === 13 || byte === 10) {
            // CR or LF — end of line, speak what we have.
            this._flush();
        } else if (byte < 32) {
            // VDU control code — skip its parameter bytes.
            this._skipBytes = VDU_PARAM_COUNT[byte];
        }
        // DEL (127) and bytes >126 are silently ignored.
    }

    /** RS-423 handler interface: nothing to send back to the BBC. */
    tryReceive() {
        return -1;
    }

    // ------------------------------------------------------------------

    _flush() {
        const text = this._buffer.trim();
        this._buffer = "";
        if (!text) return;
        this._speak(text);
    }

    _speak(text) {
        if (typeof speechSynthesis === "undefined") return;
        // Cancel whatever is currently being spoken so output stays current.
        speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        speechSynthesis.speak(utterance);
    }

    _cancelSpeech() {
        if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    }
}

"use strict";

/**
 * Centronics printer attached to the user VIA: acknowledges each character and keeps the most
 * recent output so it can be shown whenever a printer window is opened.
 */

export const MaxBufferedChars = 64 * 1024;

export class Printer {
    /**
     * @param {object} [handlers]
     * @param {function(string): void} [handlers.onOutput] called with each character as it is printed
     * @param {function(): void} [handlers.onFirstOutput] called once, when the machine first prints
     */
    constructor({ onOutput = () => {}, onFirstOutput = () => {} } = {}) {
        this._onOutput = onOutput;
        this._onFirstOutput = onFirstOutput;
        this._uservia = null;
        this._olderText = "";
        this._newerText = "";
        this._hasPrinted = false;

        // Handed straight to the VIA as its CA2 callback, so it cannot rely on being bound.
        this.outputStrobe = (level, output) => {
            if (!output || level) return;

            const uservia = this._uservia;
            // Ack the character by pulsing CA1 low.
            uservia.setca1(false);
            uservia.setca1(true);
            this._append(String.fromCharCode(uservia.ora));
        };
    }

    attach(uservia) {
        this._uservia = uservia;
        // The ack line idles high, so that each ack is a falling edge.
        uservia.setca1(true);
    }

    /** The most recent output, at most MaxBufferedChars of it. */
    get text() {
        return (this._olderText + this._newerText).slice(-MaxBufferedChars);
    }

    _append(char) {
        // Two chunks so the bound costs a trim when the text is read, not one per character.
        this._newerText += char;
        if (this._newerText.length >= MaxBufferedChars) {
            this._olderText = this._newerText;
            this._newerText = "";
        }
        if (!this._hasPrinted) {
            this._hasPrinted = true;
            this._onFirstOutput();
        }
        this._onOutput(char);
    }
}

/**
 * Centronics printer attached to the user VIA: acknowledges each character and keeps the most
 * recent output so it can be shown whenever a printer window is opened. Dispatches "output" with
 * each character as its detail, and "first-output" once, when the machine first prints.
 */

export const MaxBufferedChars = 64 * 1024;

export class Printer extends EventTarget {
    constructor() {
        super();
        this._uservia = null;
        this._olderText = "";
        this._newerText = "";
        this._hasPrinted = false;
    }

    outputStrobe(level, output) {
        if (!output || level) return;

        const uservia = this._uservia;
        // Ack the character by pulsing CA1 low.
        uservia.setca1(false);
        uservia.setca1(true);
        this._append(String.fromCharCode(uservia.ora));
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
            this.dispatchEvent(new Event("first-output"));
        }
        this.dispatchEvent(new CustomEvent("output", { detail: char }));
    }
}

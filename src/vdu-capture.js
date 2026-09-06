/**
 * Turns the bytes a program sends to the VDU into text elements,
 * `{ x, y, text, foreground, background, mode }`, following the cursor and
 * colour codes and swallowing the parameters of the rest. Text-mode output
 * only; anything visual wants a screenshot.
 */
// How many parameter bytes follow each BBC VDU code that takes any.
const SequenceParamCounts = {
    1: 1, // next character to the printer only
    17: 1, // COLOUR n
    18: 2, // GCOL
    19: 5, // define logical colour
    22: 1, // MODE n
    25: 5, // PLOT
    28: 4, // define text window
    29: 4, // define graphics origin
    31: 2, // TAB(x,y)
};

export class VduTextCapture {
    constructor(onElement, { isAtom = false } = {}) {
        this.onElement = onElement;
        this.isAtom = isAtom;
        this.attributes = { x: 0, y: 0, text: "", foreground: 7, background: 0, mode: 7 };
        this.currentText = "";
        this.params = [];
        this.nextN = 0;
        this.vduProc = null;
    }

    flush() {
        if (this.currentText.length) {
            this.onElement({ ...this.attributes, text: this.currentText });
            this.attributes.x += this.currentText.length;
        }
        this.currentText = "";
    }

    onChar(c) {
        const attributes = this.attributes;
        if (this.nextN) {
            this.params.push(c);
            if (--this.nextN === 0) {
                if (this.vduProc) this.vduProc(this.params);
                this.params = [];
                this.vduProc = null;
            }
            return;
        }
        switch (c) {
            case 10:
                this.flush();
                attributes.y++;
                return;
            case 12:
                this.flush();
                attributes.x = 0;
                attributes.y = 0;
                return;
            case 13:
                this.flush();
                attributes.x = 0;
                return;
        }
        // The Atom has no multi-byte VDU sequences; treating its bytes as
        // parameters would swallow printable characters.
        const paramCount = this.isAtom ? undefined : SequenceParamCounts[c];
        if (paramCount !== undefined) {
            this.flush();
            this.nextN = paramCount;
            this.vduProc = this.sequenceHandlers[c] ?? null;
            return;
        }
        if (c >= 32 && c < 0x7f) this.currentText += String.fromCharCode(c);
        else this.flush();
    }

    get sequenceHandlers() {
        const attributes = this.attributes;
        return {
            17: (p) => {
                if (p[0] & 0x80) attributes.background = p[0] & 0xf;
                else attributes.foreground = p[0] & 0xf;
            },
            22: (p) => {
                attributes.mode = p[0];
                attributes.x = 0;
                attributes.y = 0;
                attributes.foreground = 7;
                attributes.background = 0;
            },
            31: (p) => {
                attributes.x = p[0];
                attributes.y = p[1];
            },
        };
    }

    /** The decoder's position in the byte stream, for a machine snapshot to carry. */
    snapshot() {
        return {
            attributes: { ...this.attributes },
            currentText: this.currentText,
            params: [...this.params],
            nextN: this.nextN,
        };
    }

    /**
     * Puts back a snapshot(). The handler for a half-read sequence is a
     * closure and does not survive, so such a sequence is dropped rather
     * than printed as text.
     */
    restore(state) {
        Object.assign(this.attributes, state.attributes);
        this.currentText = state.currentText;
        this.params = [...state.params];
        this.nextN = state.nextN;
        this.vduProc = null;
    }
}

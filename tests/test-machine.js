import * as fdc from "../src/fdc.js";
import { fake6502 } from "../src/fake6502.js";
import { findModel } from "../src/models.js";
import assert from "assert";
import * as utils from "../src/utils.js";
import * as Tokeniser from "../src/basic-tokenise.js";

const MaxCyclesPerIter = 100 * 1000;

export class TestMachine {
    constructor(model, opts) {
        model = model || "B-DFS1.2";
        this.processor = fake6502(findModel(model), opts || {});
    }

    async initialise() {
        await this.processor.initialise();
    }

    runFor(cycles) {
        let left = cycles;
        let stopped = false;
        return new Promise((resolve) => {
            const runAnIter = () => {
                const todo = Math.max(0, Math.min(left, MaxCyclesPerIter));
                if (todo) {
                    stopped = !this.processor.execute(todo);
                    left -= todo;
                }
                if (left && !stopped) {
                    setTimeout(runAnIter, 0);
                } else {
                    resolve(stopped);
                }
            };
            runAnIter();
        });
    }

    async runUntilVblank() {
        let hit = false;
        if (this.processor.isMaster) throw new Error("Not yet implemented");
        const hook = this.processor.debugInstruction.add((addr) => {
            if (addr === 0xdd15) {
                hit = true;
                return true;
            }
        });
        await this.runFor(10 * 1000 * 1000);
        hook.remove();
        assert(hit, "did not hit appropriate breakpoint in time");
    }

    async runUntilInput(secs) {
        if (!secs) secs = 120;
        console.log("Running until keyboard input requested");
        const idleAddr = this.processor.model.isMaster ? 0xe7e6 : 0xe581;
        let hit = false;
        const hook = this.processor.debugInstruction.add((addr) => {
            if (addr === idleAddr) {
                hit = true;
                return true;
            }
        });
        await this.runFor(secs * 2 * 1000 * 1000);
        hook.remove();
        assert(hit, "did not hit appropriate breakpoint in time");
        return this.runFor(10 * 1000);
    }

    async runUntilAddress(targetAddr, secs) {
        if (!secs) secs = 120;
        let hit = false;
        const hook = this.processor.debugInstruction.add((addr) => {
            if (addr === targetAddr) {
                hit = true;
                return true;
            }
        });
        await this.runFor(secs * 2 * 1000 * 1000);
        hook.remove();
        assert(hit, "did not hit appropriate breakpoint in time");
    }

    async loadDisc(image) {
        const data = await fdc.load(image);
        this.processor.fdc.loadDisc(0, fdc.discFor(this.processor.fdc, "", data));
    }

    async loadBasic(source) {
        const tokeniser = await Tokeniser.create();
        const tokenised = tokeniser.tokenise(source);
        // TODO: dedupe from main.js
        const page = this.readbyte(0x18) << 8;
        for (let i = 0; i < tokenised.length; ++i) {
            this.writebyte(page + i, tokenised.charCodeAt(i));
        }
        // Set VARTOP (0x12/3) and TOP(0x02/3)
        const end = page + tokenised.length;
        const endLow = end & 0xff;
        const endHigh = (end >>> 8) & 0xff;
        this.writebyte(0x02, endLow);
        this.writebyte(0x03, endHigh);
        this.writebyte(0x12, endLow);
        this.writebyte(0x13, endHigh);
    }

    /**
     * Convert an ASCII character to a {code, shift} pair for the BBC keyboard.
     */
    _charToKey(ch) {
        switch (ch) {
            case "\n":
            case "\r":
                return { code: 13, shift: false };
            case '"':
                return { code: utils.keyCodes.K2, shift: true };
            case "*":
                return { code: utils.keyCodes.APOSTROPHE, shift: true };
            case "!":
                return { code: utils.keyCodes.K1, shift: true };
            case ".":
                return { code: utils.keyCodes.PERIOD, shift: false };
            case ";":
                return { code: utils.keyCodes.SEMICOLON, shift: false };
            case ":":
                return { code: utils.keyCodes.APOSTROPHE, shift: false };
            case ",":
                return { code: utils.keyCodes.COMMA, shift: false };
            case "&":
                return { code: utils.keyCodes.K6, shift: true };
            case " ":
                return { code: utils.keyCodes.SPACE, shift: false };
            case "-":
                return { code: utils.keyCodes.MINUS, shift: false };
            case "=":
                return { code: utils.keyCodes.MINUS, shift: true };
            case "+":
                return { code: utils.keyCodes.SEMICOLON, shift: true };
            case "^":
                return { code: utils.keyCodes.EQUALS, shift: false };
            case "~":
                return { code: utils.keyCodes.EQUALS, shift: true };
            case "[":
                return { code: utils.keyCodes.LEFT_SQUARE_BRACKET, shift: false };
            case "]":
                return { code: utils.keyCodes.RIGHT_SQUARE_BRACKET, shift: false };
            case "{":
                return { code: utils.keyCodes.LEFT_SQUARE_BRACKET, shift: true };
            case "}":
                return { code: utils.keyCodes.HASH, shift: true };
            case "\\":
                return { code: utils.keyCodes.BACKSLASH, shift: false };
            case "/":
                return { code: utils.keyCodes.SLASH, shift: false };
            case "?":
                return { code: utils.keyCodes.SLASH, shift: true };
            case "<":
                return { code: utils.keyCodes.COMMA, shift: true };
            case ">":
                return { code: utils.keyCodes.PERIOD, shift: true };
            case "(":
                return { code: utils.keyCodes.K8, shift: true };
            case ")":
                return { code: utils.keyCodes.K9, shift: true };
            case "@":
                return { code: utils.keyCodes.BACK_QUOTE, shift: false };
            case "#":
                return { code: utils.keyCodes.K3, shift: true };
            case "$":
                return { code: utils.keyCodes.K4, shift: true };
            case "%":
                return { code: utils.keyCodes.K5, shift: true };
            default:
                return { code: ch.toUpperCase().charCodeAt(0), shift: false };
        }
    }

    /**
     * Type text by installing a debugInstruction hook that presses/releases
     * keys at timed intervals during CPU execution.  The hook persists across
     * runFor calls, so breakpoints naturally coexist: if a breakpoint halts
     * execution mid-typing, the remaining characters are typed when execution
     * resumes.
     */
    async type(text) {
        const fullText = text + "\n"; // append RETURN
        const keys = fullText.split("").map((ch) => this._charToKey(ch));
        const holdMillis = 40;
        const clocksPerSecond = Math.floor(this.processor.cpuMultiplier * 2000000);
        let index = 0;
        let phase = "idle"; // "idle" → "down" → "idle"
        let nextEventMillis = 0;
        let done = false;

        const hook = this.processor.debugInstruction.add(() => {
            const millis = this.processor.cycleSeconds * 1000 + this.processor.currentCycles / (clocksPerSecond / 1000);
            if (millis < nextEventMillis) return;

            if (phase === "down") {
                // Release current key
                const key = keys[index];
                this.processor.sysvia.keyUp(key.code);
                if (key.shift) this.processor.sysvia.keyUp(16);
                index++;
                phase = "idle";
                nextEventMillis = millis + holdMillis;
                return;
            }

            // phase === "idle"
            if (index >= keys.length) {
                hook.remove();
                done = true;
                return;
            }

            // Press next key
            const key = keys[index];
            if (key.shift) this.processor.sysvia.keyDown(16);
            this.processor.sysvia.keyDown(key.code);
            phase = "down";
            nextEventMillis = millis + holdMillis;
        });

        // Drive execution until all characters are typed or a breakpoint fires.
        const cyclesPerChar = 80 * 1000;
        const totalCycles = keys.length * cyclesPerChar;
        const stopped = await this.runFor(totalCycles);
        if (!done && !stopped) {
            // Shouldn't happen if cycle budget is sufficient, but be safe
            await this.runFor(totalCycles);
        }
    }

    writebyte(addr, val) {
        this.processor.writemem(addr, val);
    }

    readbyte(addr) {
        return this.processor.readmem(addr);
    }

    readword(addr) {
        return this.readbyte(addr) | (this.readbyte(addr + 1) << 8);
    }

    captureText(onElement) {
        const attributes = {
            x: 0,
            y: 0,
            text: "",
            foreground: 7,
            background: 0,
            mode: 7,
        };
        let currentText = "";
        let params = [];
        let nextN = 0;
        let vduProc = null;

        function flush() {
            if (currentText.length) {
                attributes.text = currentText;
                onElement(attributes);
                attributes.x += currentText.length; // Approximately...anyway
            }
            currentText = "";
        }

        function onChar(c) {
            if (nextN) {
                params.push(c);
                if (--nextN === 0) {
                    if (vduProc) vduProc(params);
                    params = [];
                    vduProc = null;
                }
                return;
            }
            switch (c) {
                case 1: // Next char to printer
                    nextN = 1;
                    break;
                case 10:
                    attributes.y++;
                    break;
                case 12: // CLS
                    attributes.x = 0;
                    attributes.y = 0;
                    break;
                case 13:
                    attributes.x = 0;
                    break;
                case 17: // Text colour
                    nextN = 1;
                    vduProc = function (params) {
                        if (params[0] & 0x80) attributes.background = params[0] & 0xf;
                        else attributes.foreground = params[0] & 0xf;
                    };
                    break;
                case 18: // GCOL
                    nextN = 2;
                    break;
                case 19: // logical colour
                    nextN = 5;
                    break;
                case 22: // mode
                    nextN = 1;
                    vduProc = function (params) {
                        attributes.mode = params[0];
                        attributes.x = 0;
                        attributes.y = 0;
                    };
                    break;
                case 25: // plot
                    nextN = 5;
                    break;
                case 28: // text window
                    nextN = 4;
                    break;
                case 29: // origin
                    nextN = 4;
                    break;
                case 31: // text location
                    nextN = 2;
                    vduProc = function (params) {
                        attributes.x = params[0];
                        attributes.y = params[1];
                    };
            }
            if (c >= 32 && c < 0x7f) {
                currentText += String.fromCharCode(c);
            } else flush();
            return false;
        }

        const wrchv = this.readword(0x20e);
        this.processor.debugInstruction.add((addr) => {
            if (addr === wrchv) onChar(this.processor.a);
            return false;
        });
    }
}

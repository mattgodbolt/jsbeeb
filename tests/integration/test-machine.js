import * as fdc from "../../fdc.js";
import { fake6502 } from "../../fake6502.js";
import { findModel } from "../../models.js";
import { FakeVideo } from "../../video.js";
import assert from "assert";
import * as utils from "../../utils.js";

const MaxCyclesPerIter = 100 * 1000;

export class TestMachine {
    constructor(model) {
        model = model || "B-DFS1.2";
        this.processor = fake6502(findModel(model), { video: new FakeVideo() });
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
                    resolve();
                }
            };
            runAnIter();
        });
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

    async type(text) {
        console.log("Typing '" + text + "'");
        const cycles = 40 * 1000;

        const kd = (ch) => {
            this.processor.sysvia.keyDown(ch);
            return this.runFor(cycles).then(() => {
                this.processor.sysvia.keyUp(ch);
                return this.runFor(cycles);
            });
        };

        const typeChar = (ch) => {
            let shift = false;
            if (ch === '"') {
                ch = 50;
                shift = true;
            } else if (ch === "*") {
                ch = utils.keyCodes.APOSTROPHE;
                shift = true;
            } else if (ch === ".") {
                ch = utils.keyCodes.PERIOD;
            } else ch = ch.toUpperCase().charCodeAt(0);
            if (shift) {
                this.processor.sysvia.keyDown(16);
                return this.runFor(cycles).then(() => {
                    return kd(ch).then(() => {
                        this.processor.sysvia.keyUp(16);
                        return this.runFor(cycles);
                    });
                });
            } else {
                return kd(ch);
            }
        };

        return text
            .split("")
            .reduce(function (p, char) {
                return p.then(function () {
                    return typeChar(char);
                });
            }, Promise.resolve())
            .then(function () {
                return kd(13);
            });
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

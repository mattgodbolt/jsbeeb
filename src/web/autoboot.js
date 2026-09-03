import * as atomKeymap from "../keymap-atom.js";
import * as tokeniser from "../basic-tokenise.js";
import { basicIdleAddr, installBasic } from "../basic-loader.js";
import { noteEvent } from "./analytics.js";
import { BBC, stringToBBCKeys } from "../keymap.js";

/** Booting and typing for the machine at startup: shift-break, *TAPE incantations and BASIC programs. */
export class Autoboot {
    /** @param {Function} deps.sendKeys sends a raw key sequence once the keyboard exists */
    constructor({ model, processor, sendKeys }) {
        this.model = model;
        this.processor = processor;
        this.sendKeys = sendKeys;
    }

    /** Convert text to machine-appropriate key sequences (BBC or Atom) */
    stringToMachineKeys(text) {
        return this.model.isAtom ? atomKeymap.stringToATOMKeys(text) : stringToBBCKeys(text);
    }

    boot(image) {
        console.log("Autobooting disc");
        noteEvent("init", "autoboot", image);

        // Shift-break simulation, hold SHIFT for 1000ms.
        this.sendKeys([BBC.SHIFT, 1000], false);
    }

    type(keys) {
        console.log("Auto typing '" + keys + "'");
        noteEvent("init", "autochain");

        const bbcKeys = this.stringToMachineKeys(keys);
        this.sendKeys([1000].concat(bbcKeys), false);
    }

    chainTape() {
        console.log("Auto Chaining Tape");
        noteEvent("init", "autochain");

        const bbcKeys = this.stringToMachineKeys('*TAPE\nCH.""\n');
        this.sendKeys([1000].concat(bbcKeys), false);
    }

    runTape() {
        console.log("Auto Running Tape");
        noteEvent("init", "autorun");

        const bbcKeys = this.stringToMachineKeys("*TAPE\n*/\n");
        this.sendKeys([1000].concat(bbcKeys), false);
    }

    runBasic() {
        console.log("Auto Running basic");
        noteEvent("init", "autorunbasic");

        const bbcKeys = this.stringToMachineKeys("RUN\n");
        this.sendKeys([1000].concat(bbcKeys), false);
    }

    /**
     * Tokenises a BASIC program and installs it once the OS reaches its idle
     * loop, so it lands after the machine has finished starting up.
     */
    async insertBasic(getBasicPromise, needsRun) {
        const prog = await getBasicPromise;
        const t = await tokeniser.create();
        const tokenised = await t.tokenise(prog);

        const { processor } = this;
        const idleAddr = basicIdleAddr(processor.model);
        const hook = processor.debugInstruction.add((addr) => {
            if (addr !== idleAddr) return;
            installBasic(tokenised, {
                readByte: (a) => processor.readmem(a),
                writeByte: (a, value) => processor.writemem(a, value),
            });
            hook.remove();
            if (needsRun) {
                this.runBasic();
            }
        });
    }
}

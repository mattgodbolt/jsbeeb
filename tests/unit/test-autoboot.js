import { beforeEach, describe, expect, it, vi } from "vitest";

import { Autoboot } from "../../src/web/autoboot.js";
import * as utils from "../../src/utils.js";

describe("Autoboot", () => {
    let sendKeys;
    let processor;

    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        sendKeys = vi.fn();
        const memory = new Uint8Array(0x10000);
        memory[0x18] = 0x19;
        processor = {
            model: { isMaster: false },
            memory,
            readmem: (addr) => memory[addr],
            writemem: (addr, value) => (memory[addr] = value),
            debugInstruction: {
                hook: null,
                add(fn) {
                    this.hook = fn;
                    return { remove: () => (this.hook = null) };
                },
            },
        };
    });

    const make = (isAtom = false) => new Autoboot({ model: { isAtom }, processor, sendKeys });

    it("boots a disc by holding SHIFT through a break", () => {
        make().boot("elite.ssd");
        expect(sendKeys).toHaveBeenCalledWith([utils.BBC.SHIFT, 1000], false);
    });

    it("types the requested keys after a pause", () => {
        make().type("*CAT\n");
        const [keys, checkLocks] = sendKeys.mock.calls[0];
        expect(keys[0]).toBe(1000);
        expect(keys.length).toBeGreaterThan(1);
        expect(checkLocks).toBe(false);
    });

    it("converts keys for the machine it is booting", () => {
        make(false).type("A");
        const bbcKeys = sendKeys.mock.calls[0][0];
        make(true).type("A");
        const atomKeys = sendKeys.mock.calls[1][0];
        expect(bbcKeys).not.toEqual(atomKeys);
    });

    it("chains and runs tapes with the right incantations", () => {
        const spelled = vi.spyOn(utils, "stringToBBCKeys");
        make().chainTape();
        expect(spelled).toHaveBeenCalledWith('*TAPE\nCH.""\n');
        make().runTape();
        expect(spelled).toHaveBeenCalledWith("*TAPE\n*/\n");
        vi.restoreAllMocks();
    });

    describe("insertBasic", () => {
        it("installs the program when the OS goes idle, once, and runs it when asked", async () => {
            await make().insertBasic(Promise.resolve('10 PRINT "HI"'), true);
            expect(processor.debugInstruction.hook).toBeTruthy();

            // Not yet: some other instruction.
            processor.debugInstruction.hook(0x1234);
            expect(processor.memory[0x1900]).toBe(0);
            expect(sendKeys).not.toHaveBeenCalled();

            // The B's idle loop address.
            processor.debugInstruction.hook(0xe581);
            expect(processor.memory[0x1900]).not.toBe(0);
            expect(processor.debugInstruction.hook).toBeNull();
            // RUN typed after a pause.
            expect(sendKeys).toHaveBeenCalledTimes(1);
            expect(sendKeys.mock.calls[0][0][0]).toBe(1000);
        });

        it("hooks the Master's idle loop on a Master", async () => {
            processor.model.isMaster = true;
            await make().insertBasic(Promise.resolve("10 END"), false);
            processor.debugInstruction.hook(0xe581);
            expect(processor.memory[0x1900]).toBe(0);
            processor.debugInstruction.hook(0xe7e6);
            expect(processor.memory[0x1900]).not.toBe(0);
            expect(sendKeys).not.toHaveBeenCalled();
        });
    });
});

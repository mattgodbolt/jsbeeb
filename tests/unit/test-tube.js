import { describe, it, expect, beforeEach } from "vitest";
import { Tube } from "../../src/tube.js";

// Tube ULA register addresses, as seen at 0xFEE0 on the host and 0xFEF8 on the parasite.
const R1Status = 0;
const R1Data = 1;
const R3Data = 5;
// Written to R1 status: S sets the flags named in the rest of the byte, V selects two-byte R3.
const SetControlFlags = 0x80;
const TwoByteR3 = 0x10;

function fakeCpu() {
    return { interrupt: 0, resetHeldLow: false, NMI() {} };
}

describe("Tube ULA", () => {
    let tube;

    beforeEach(() => {
        tube = new Tube(fakeCpu(), fakeCpu());
        tube.reset(true);
    });

    describe("two-byte register 3 transfers", () => {
        beforeEach(() => {
            tube.hostWrite(R1Status, SetControlFlags | TwoByteR3);
        });

        it("delivers both bytes to the parasite in order", () => {
            tube.hostWrite(R3Data, 0x11);
            tube.hostWrite(R3Data, 0x22);

            expect(tube.parasiteRead(R3Data)).toBe(0x11);
            expect(tube.parasiteRead(R3Data)).toBe(0x22);
        });

        it("leaves the register 1 FIFO alone", () => {
            tube.hostWrite(R3Data, 0x11);
            tube.hostWrite(R3Data, 0x22);

            tube.hostWrite(R1Data, 0x77);

            expect(tube.parasiteRead(R1Data)).toBe(0x77);
        });
    });
});

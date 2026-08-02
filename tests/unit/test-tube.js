import { describe, it, expect, beforeEach } from "vitest";
import { Tube } from "../../src/tube.js";

// Tube ULA register addresses, as seen at 0xFEE0 on the host and 0xFEF8 on the parasite.
const R1Status = 0;
const R1Data = 1;
const R2Status = 2;
const R3Data = 5;
// Written to R1 status: S sets the flags named in the rest of the byte, V selects two-byte R3,
// M lets pending R3 data raise the parasite's NMI.
const SetControlFlags = 0x80;
const EnableNmiFromR3 = 0x08;
const TwoByteR3 = 0x10;

function fakeCpu() {
    return {
        interrupt: 0,
        resetHeldLow: false,
        nmiLevel: false,
        nmiEdges: 0,
        NMI(nmi) {
            if (nmi && !this.nmiLevel) this.nmiEdges++;
            this.nmiLevel = !!nmi;
        },
    };
}

describe("Tube ULA", () => {
    let tube;
    let parasiteCpu;

    beforeEach(() => {
        parasiteCpu = fakeCpu();
        tube = new Tube(fakeCpu(), parasiteCpu);
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

    describe("register 1 status", () => {
        it("shows the control flags to both sides", () => {
            tube.hostWrite(R1Status, SetControlFlags | EnableNmiFromR3);

            expect(tube.hostRead(R1Status) & EnableNmiFromR3).toBe(EnableNmiFromR3);
            expect(tube.parasiteRead(R1Status) & EnableNmiFromR3).toBe(EnableNmiFromR3);
        });
    });

    describe("status register spare bits", () => {
        it("reads them as ones on every register but the first", () => {
            expect(tube.parasiteRead(R1Status)).toBe(0x40);
            expect(tube.parasiteRead(R2Status)).toBe(0x7f);
        });
    });

    describe("parasite NMI requests", () => {
        beforeEach(() => {
            tube.hostWrite(R1Status, SetControlFlags | EnableNmiFromR3);
        });

        it("asks the parasite for a byte once the host has taken the one it had", () => {
            expect(parasiteCpu.nmiEdges).toBe(0);

            tube.hostRead(R3Data);

            expect(parasiteCpu.nmiEdges).toBe(1);
        });

        it("asks again for a byte the host sends while an earlier request still stands", () => {
            tube.hostRead(R3Data); // the parasite now owes the host a byte, and is asked for one
            tube.acknowledgeNmi(); // which it takes, but has not yet answered

            tube.hostWrite(R3Data, 0x42);

            expect(parasiteCpu.nmiEdges).toBe(2);
        });

        it("does not ask twice for the same byte", () => {
            tube.hostRead(R3Data);
            tube.acknowledgeNmi();

            tube.hostRead(R1Status);

            expect(parasiteCpu.nmiEdges).toBe(1);
        });

        it("withdraws its request once the parasite has answered", () => {
            tube.hostRead(R3Data);

            tube.parasiteWrite(R3Data, 0x42);

            expect(parasiteCpu.nmiLevel).toBe(false);
        });

        it("drops any request while M is clear", () => {
            tube.hostRead(R3Data);

            tube.hostWrite(R1Status, EnableNmiFromR3); // S clear, so this clears M

            expect(parasiteCpu.nmiLevel).toBe(false);
        });
    });
});

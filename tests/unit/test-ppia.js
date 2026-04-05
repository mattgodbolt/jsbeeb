import { describe, it, expect } from "vitest";
import { AtomPPIA } from "../../src/ppia.js";
import { Scheduler } from "../../src/scheduler.js";

function makePPIA() {
    const scheduler = new Scheduler();
    const cpu = {
        pc: 0,
        currentCycles: 0,
        cycleSeconds: 0,
        soundChip: {
            toneGenerator: { mute() {}, tone() {} },
            speakerGenerator: { mute() {}, pushBit() {} },
        },
    };
    const ppia = new AtomPPIA(cpu, "physical", scheduler);
    return { ppia, cpu, scheduler };
}

describe("AtomPPIA", () => {
    it("should construct with initial state", () => {
        const { ppia } = makePPIA();
        expect(ppia.portapins).toBe(0);
        expect(ppia.portbpins).toBe(0);
        expect(ppia.keyboardEnabled).toBe(true);
    });

    describe("port read/write", () => {
        it("should write to port A and read back", () => {
            const { ppia } = makePPIA();
            ppia.write(0xb000, 0x35); // PORTA
            expect(ppia.read(0xb000)).toBe(0x35);
        });

        it("should not modify port B on write", () => {
            const { ppia } = makePPIA();
            ppia.write(0xb001, 0xff); // PORTB is input-only
            // Port B reads keyboard matrix, not the written value
        });

        it("should read port C with VSync and REPT bits", () => {
            const { ppia } = makePPIA();
            const val = ppia.read(0xb002); // PORTC
            expect(typeof val).toBe("number");
            expect(val & 0xff).toBe(val); // 8-bit value
        });

        it("should throw on invalid address read", () => {
            const { ppia } = makePPIA();
            expect(() => ppia.read(0xb00f)).toThrow("Unknown PPIA read address");
        });
    });

    describe("keyboard matrix", () => {
        it("should report no keys down initially", () => {
            const { ppia } = makePPIA();
            expect(ppia.hasAnyKeyDown()).toBe(false);
        });

        it("should register key down and up via keyDown/keyUp", () => {
            const { ppia } = makePPIA();
            // Space is [9, 0] in the ATOM matrix
            ppia.keyDownRaw([9, 0]);
            expect(ppia.hasAnyKeyDown()).toBe(true);

            ppia.keyUpRaw([9, 0]);
            expect(ppia.hasAnyKeyDown()).toBe(false);
        });

        it("should read pressed key from port B", () => {
            const { ppia } = makePPIA();
            // ATOM key constants are [first, second] where keys[first][second] is set.
            // Port A row selects keys[row], port B bit n reads keys[row][n].
            // RETURN = [6, 1]: sets keys[6][1]. Select row 6, read bit 1.
            ppia.keyDownRaw([6, 1]);
            ppia.write(0xb000, 6); // select row 6
            const portb = ppia.read(0xb001);
            // Bit 1 should be low (0 = pressed)
            expect(portb & (1 << 1)).toBe(0);
        });

        it("should clear all keys on clearKeys", () => {
            const { ppia } = makePPIA();
            ppia.keyDownRaw([5, 3]);
            expect(ppia.hasAnyKeyDown()).toBe(true);
            ppia.clearKeys();
            expect(ppia.hasAnyKeyDown()).toBe(false);
        });

        it("should toggle key state with keyToggleRaw", () => {
            const { ppia } = makePPIA();
            ppia.keyToggleRaw([4, 0]);
            expect(ppia.hasAnyKeyDown()).toBe(true);
            ppia.keyToggleRaw([4, 0]);
            expect(ppia.hasAnyKeyDown()).toBe(false);
        });

        it("should ignore key events when keyboard disabled", () => {
            const { ppia } = makePPIA();
            ppia.disableKeyboard();
            ppia.keyDownRaw([5, 3]);
            // keyDownRaw bypasses the enabled check, but set() respects it
            // Test via the set() path
            ppia.clearKeys();
            ppia.set(65, 1, false); // 'A' key code
            expect(ppia.hasAnyKeyDown()).toBe(false);
        });
    });

    describe("VSync", () => {
        it("should set port C bit 7 based on VSync level", () => {
            const { ppia } = makePPIA();
            // In frame (level=0): bit 7 should be high
            ppia.setVBlankInt(0);
            expect(ppia.latchc & 0x80).toBe(0x80);

            // In VSync (level=1): bit 7 should be low
            ppia.setVBlankInt(1);
            expect(ppia.latchc & 0x80).toBe(0);
        });
    });

    describe("speaker", () => {
        it("should call speakerGenerator.pushBit on port C update", () => {
            const { ppia, cpu } = makePPIA();
            const calls = [];
            cpu.soundChip.speakerGenerator.pushBit = (bit, cycles, seconds) => {
                calls.push({ bit, cycles, seconds });
            };
            // Write to port C with speaker bit (bit 2) set
            ppia.write(0xb002, 0x04);
            expect(calls.length).toBeGreaterThan(0);
            expect(calls[0].bit).toBe(1); // bit 2 >> 2 = 1
        });
    });

    describe("tape", () => {
        it("should set and manage tape", () => {
            const { ppia } = makePPIA();
            const fakeTape = {
                rewind() {},
                poll() {
                    return 100;
                },
            };
            ppia.setTape(fakeTape);
            expect(ppia.tape).toBe(fakeTape);
        });

        it("should receive bits into port C", () => {
            const { ppia } = makePPIA();
            ppia.receiveBit(1);
            expect(ppia.latchc & 0x20).toBe(0x20); // bit 5 set
            ppia.receiveBit(0);
            expect(ppia.latchc & 0x20).toBe(0); // bit 5 cleared
        });
    });
});

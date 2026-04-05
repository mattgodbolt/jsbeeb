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
            const before = ppia.read(0xb001);
            ppia.write(0xb001, 0xff); // PORTB is input-only
            expect(ppia.read(0xb001)).toBe(before);
        });

        it("should read port C with VSync and REPT bits", () => {
            const { ppia } = makePPIA();
            const val = ppia.read(0xb002); // PORTC
            expect(typeof val).toBe("number");
            expect(val & 0xff).toBe(val); // 8-bit value
        });

        it("should return open bus for unmapped register reads", () => {
            const { ppia } = makePPIA();
            // CREG (reg 3) is write-only; returns open bus (addr >>> 8)
            const val = ppia.read(0xb003);
            expect(val).toBe(0xb003 >>> 8);
        });
    });

    describe("CREG Bit Set/Reset", () => {
        it("should set speaker bit via BSR write", () => {
            const { ppia } = makePPIA();
            // BSR: D7=0, bits 1-3 select pin, bit 0 = set/reset value
            // Pin 2 (speaker) set: val = 0b0000_0101 = 0x05
            ppia.write(0xb003, 0x05);
            expect(ppia.portcpins & 0x04).toBe(0x04);
        });

        it("should clear speaker bit via BSR write", () => {
            const { ppia } = makePPIA();
            ppia.write(0xb003, 0x05); // set speaker
            ppia.write(0xb003, 0x04); // clear speaker
            expect(ppia.portcpins & 0x04).toBe(0);
        });

        it("should preserve CSS when toggling speaker", () => {
            const { ppia } = makePPIA();
            ppia.write(0xb003, 0x07); // set CSS (pin 3)
            ppia.write(0xb003, 0x05); // set speaker (pin 2)
            expect(ppia.portcpins & 0x08).toBe(0x08); // CSS still set
            expect(ppia.portcpins & 0x04).toBe(0x04); // speaker set
        });

        it("should ignore mode-set writes (D7=1)", () => {
            const { ppia } = makePPIA();
            ppia.write(0xb003, 0x05); // set speaker via BSR
            ppia.write(0xb003, 0x80); // mode-set (should be ignored)
            expect(ppia.portcpins & 0x04).toBe(0x04); // speaker unchanged
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

    describe("snapshot/restore", () => {
        it("should round-trip state through snapshot and restore", () => {
            const { ppia } = makePPIA();
            // Mutate state
            ppia.write(0xb000, 0x35); // port A
            ppia.keyDownRaw([6, 1]); // press a key
            ppia.write(0xb003, 0x05); // BSR: set speaker bit

            const snapshot = ppia.snapshotState();
            expect(snapshot.latcha).toBe(0x35);
            expect(snapshot.keyboardEnabled).toBe(true);

            // Create a fresh PPIA and restore
            const { ppia: ppia2 } = makePPIA();
            ppia2.restoreState(snapshot);

            expect(ppia2.latcha).toBe(0x35);
            expect(ppia2.keyboardEnabled).toBe(true);
            expect(ppia2.keys[6][1]).toBe(1);
        });

        it("should produce JSON-serializable state", () => {
            const { ppia } = makePPIA();
            ppia.write(0xb000, 0x42);
            ppia.keyDownRaw([3, 2]);
            const snapshot = ppia.snapshotState();

            // Round-trip through JSON
            const json = JSON.stringify(snapshot);
            const parsed = JSON.parse(json);

            const { ppia: ppia2 } = makePPIA();
            ppia2.restoreState(parsed);
            expect(ppia2.latcha).toBe(0x42);
            expect(ppia2.keys[3][2]).toBe(1);
        });
    });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AtomPPIA } from "../../src/ppia.js";
import { ATOM } from "../../src/keymap-atom.js";
import { keyCodes } from "../../src/keymap.js";
import { Scheduler } from "../../src/scheduler.js";
import { AtomSoundChip } from "../../src/soundchip.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

function makePPIA(layout = "physical") {
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
    const ppia = new AtomPPIA(cpu, layout, scheduler);
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

        it("should ignore addresses 0xB008-0xB00F", () => {
            const { ppia } = makePPIA();
            // Addresses 8+ are outside the 8255's decode range.
            // Writes should be ignored, reads should return open bus.
            ppia.write(0xb000, 0x35);
            ppia.write(0xb008, 0xff); // should be ignored
            expect(ppia.read(0xb000)).toBe(0x35); // unchanged
            expect(ppia.read(0xb008)).toBe(0xb008 >>> 8); // open bus
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

        it.each([0, 1])("sounds the first rising edge after a hard reset taken with the speaker at %i", (level) => {
            const { ppia, cpu, scheduler } = makePPIA();
            const chip = new AtomSoundChip(() => {});
            chip.setScheduler(scheduler);
            cpu.soundChip = chip;
            ppia.write(0xb002, level << 2);

            ppia.reset();
            chip.reset(true);
            cpu.currentCycles = 10;
            ppia.write(0xb002, 0x04);
            scheduler.epoch = 20;
            const out = new Float32Array(10);
            chip.render(out, 0, out.length);
            expect(out[5]).toBeGreaterThan(0.1);
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

        it("starts a new tape stopped, whatever the last one was doing", () => {
            const { ppia } = makePPIA();
            ppia.setTape({ rewind() {}, poll: () => 100 });
            ppia.pressPlay();
            ppia.setTape({ rewind() {}, poll: () => 100 });
            expect(ppia.motorOn).toBe(false);
            ppia.setTape(undefined);
            expect(ppia.motorOn).toBe(false);
        });

        it("offers PLAY and STOP as the motor itself, the way the ACIA's latch reads", () => {
            const { ppia } = makePPIA();
            ppia.setTape({ rewind() {}, poll: () => 100 });
            expect(ppia.playPressed).toBe(false);
            expect(ppia.tapeRunning).toBe(false);
            ppia.pressPlay();
            expect(ppia.motorOn).toBe(true);
            expect(ppia.playPressed).toBe(true);
            expect(ppia.tapeRunning).toBe(true);
            ppia.pressStop();
            expect(ppia.motorOn).toBe(false);
            expect(ppia.tapeRunning).toBe(false);
        });

        it("stops, motor and all, when the tape runs out", () => {
            const { ppia } = makePPIA();
            let polls = 0;
            ppia.setTape({ rewind() {}, poll: () => (++polls > 1 ? undefined : 100) });
            vi.spyOn(ppia.runTapeTask, "reschedule");
            ppia.playTape();
            expect(ppia.motorOn).toBe(true);
            ppia.runTape();
            expect(ppia.runTapeTask.reschedule).toHaveBeenCalledTimes(1);
            expect(ppia.motorOn).toBe(false);
        });

        it("stops the motor when rewinding", () => {
            const { ppia } = makePPIA();
            const fakeTape = {
                rewound: false,
                rewind() {
                    this.rewound = true;
                },
                poll: () => 100,
            };
            ppia.setTape(fakeTape);
            ppia.playTape();
            ppia.rewindTape();
            expect(ppia.motorOn).toBe(false);
            expect(fakeTape.rewound).toBe(true);
        });

        it("should receive bits into port C", () => {
            const { ppia } = makePPIA();
            ppia.receiveBit(1);
            expect(ppia.latchc & 0x20).toBe(0x20); // bit 5 set
            ppia.receiveBit(0);
            expect(ppia.latchc & 0x20).toBe(0); // bit 5 cleared
        });
    });

    describe("address mirroring", () => {
        const readPorts = (ppia, base) => [0, 1, 2].map((port) => ppia.read(base + port));

        it.each([
            ["port A, selecting a keyboard row", 0, 6],
            ["port C's output latch", 2, 0x0f],
            ["CREG, setting the speaker bit", 3, 0x05],
        ])("answers at 0xB004-0xB007 as at 0xB000-0xB003: %s", (_, register, value) => {
            const direct = makePPIA().ppia;
            const mirrored = makePPIA().ppia;
            for (const ppia of [direct, mirrored]) ppia.keyDownRaw([6, 1]);
            direct.write(0xb000 + register, value);
            mirrored.write(0xb004 + register, value);
            expect(readPorts(mirrored, 0xb004)).toEqual(readPorts(direct, 0xb000));
            expect(readPorts(direct, 0xb004)).toEqual(readPorts(direct, 0xb000));
        });
    });

    describe("snapshot/restore", () => {
        it("should round-trip a PPIA with a key down and the speaker up in vertical sync", async () => {
            await expectSnapshotRoundTrips(
                () => makePPIA().ppia,
                (ppia) => {
                    ppia.write(0xb000, 0x35);
                    ppia.write(0xb003, 0x05);
                    ppia.keyDownRaw([6, 1]);
                    ppia.setVBlankInt(true);
                },
            );
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

        it("should restore a snapshot from before latchb was dropped", () => {
            const { ppia } = makePPIA();
            ppia.write(0xb000, 0x42);
            const saved = ppia.snapshotState();

            const { ppia: restored } = makePPIA();
            restored.restoreState({ ...saved, latchb: 0 });
            expect(restored.snapshotState()).toEqual(saved);
        });
    });
});

describe("AtomPPIA natural keyboard shift override", () => {
    let ppia;

    beforeEach(() => {
        ({ ppia } = makePPIA("natural"));
    });

    function atomKeyPressed(atomKey) {
        return ppia.keys[atomKey[0]][atomKey[1]] === 1;
    }

    it("holds no Atom shift for a `@`, which the Atom prints unshifted", () => {
        ppia.keyDown(keyCodes.SHIFT_LEFT, false);
        ppia.keyDown("@", true);

        expect(atomKeyPressed(ATOM.AT)).toBe(true);
        expect(atomKeyPressed(ATOM.SHIFT)).toBe(false);
    });

    it("gives the shift key back when the character is released", () => {
        ppia.keyDown(keyCodes.SHIFT_LEFT, false);
        ppia.keyDown("@", true);
        ppia.keyUp("@");

        expect(atomKeyPressed(ATOM.AT)).toBe(false);
        expect(atomKeyPressed(ATOM.SHIFT)).toBe(true);
    });

    it("keeps the shift suppressed when shift is let go first", () => {
        ppia.keyDown(keyCodes.SHIFT_LEFT, false);
        ppia.keyDown("@", true);

        ppia.keyUp(keyCodes.SHIFT_LEFT);
        expect(atomKeyPressed(ATOM.SHIFT)).toBe(false);

        ppia.keyUp("@");
        expect(atomKeyPressed(ATOM.SHIFT)).toBe(false);
    });

    it("holds Atom shift for a `=`, which the Atom prints shifted", () => {
        ppia.keyDown("=", false);

        expect(atomKeyPressed(ATOM.MINUS_EQUALS)).toBe(true);
        expect(atomKeyPressed(ATOM.SHIFT)).toBe(true);
    });

    it("keeps the override while a plain key is pressed and released under it", () => {
        ppia.keyDown("=", false);
        ppia.keyDown("a", false);
        ppia.keyUp("a");

        expect(atomKeyPressed(ATOM.SHIFT)).toBe(true);
        ppia.keyUp("=");
        expect(atomKeyPressed(ATOM.SHIFT)).toBe(false);
    });

    it("leaves shift alone for the space bar, which prints the same either way", () => {
        ppia.keyDown(" ", true);
        ppia.keyDown(keyCodes.SHIFT_LEFT, true);

        expect(atomKeyPressed(ATOM.SPACE)).toBe(true);
        expect(atomKeyPressed(ATOM.SHIFT)).toBe(true);
    });

    it("forgets the override when the keys are cleared", () => {
        ppia.keyDown("=", false);
        ppia.clearKeys();
        ppia.keyDown("a", false);

        expect(atomKeyPressed(ATOM.SHIFT)).toBe(false);
    });

    it("leaves a shift held through the raw entry points alone", () => {
        ppia.keyDownRaw(ATOM.SHIFT);
        ppia.keyDown("a", false);

        expect(atomKeyPressed(ATOM.SHIFT)).toBe(true);
    });

    it("does not carry an override across a restore", () => {
        const saved = ppia.snapshotState();
        ppia.keyDown("=", false);
        ppia.restoreState(saved);
        ppia.keyDown("a", false);

        expect(atomKeyPressed(ATOM.SHIFT)).toBe(false);
    });

    it("takes a shift held in the restored matrix as the shift key", () => {
        ppia.keyDown(keyCodes.SHIFT_LEFT, true);
        const saved = ppia.snapshotState();
        ppia.clearKeys();
        ppia.restoreState(saved);
        ppia.keyDown("@", true);
        ppia.keyUp("@");

        expect(atomKeyPressed(ATOM.SHIFT)).toBe(true);
    });
});

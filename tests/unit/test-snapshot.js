import { describe, it, expect, beforeEach } from "vitest";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON, isSameModel } from "../../src/snapshot.js";
import { TEST_6502, TEST_65C12 } from "../../src/models.js";
import { ssdDisc } from "../helpers/disc-builders.js";
import { RomBankBytes } from "../../src/6502.js";
import { machineWithRealChips } from "./helpers.js";

const TrackBytes = 256 * 10;

function discOf(tracks, doubleSided = false) {
    const image = new Uint8Array(TrackBytes * tracks * (doubleSided ? 2 : 1)).map((_, i) => i * 7);
    return ssdDisc(image, { isDsd: doubleSided });
}

describe("Snapshot coordinator", () => {
    let cpu;
    const model = TEST_6502;

    beforeEach(async () => {
        cpu = machineWithRealChips(TEST_6502);
        await cpu.initialise();
    });

    describe("createSnapshot", () => {
        it("should create a snapshot with metadata", () => {
            const snapshot = createSnapshot(cpu, model);

            expect(snapshot.format).toBe("jsbeeb-snapshot");
            expect(snapshot.version).toBe(4);
            expect(snapshot.model).toBe(model.name);
            expect(Date.parse(snapshot.timestamp)).not.toBeNaN();
        });
    });

    describe("restoreSnapshot", () => {
        const host = () => cpu;
        const withCoProcessor = () => machineWithRealChips(TEST_6502, { tube: true });

        it.each([
            ["a different model", { restoreModel: { name: "Completely Different Machine" } }, /Model mismatch/],
            ["an unknown format", { mutate: (s) => (s.format = "unknown") }, /Unknown snapshot format/],
            ["a newer version", { mutate: (s) => (s.version = 999) }, /newer than supported/],
            [
                "a host-only snapshot into a machine with a co-processor",
                { into: withCoProcessor },
                /Co-processor mismatch/,
            ],
            ["a co-processor snapshot into a machine without one", { from: withCoProcessor }, /Co-processor mismatch/],
        ])("refuses %s", (_, { from = host, mutate = () => {}, into = host, restoreModel = model }, error) => {
            const snapshot = createSnapshot(from(), model);
            mutate(snapshot);
            expect(() => restoreSnapshot(into(), restoreModel, snapshot)).toThrow(error);
        });

        it.each([
            [
                "a v1 snapshot without an FDC field",
                (s) => {
                    s.version = 1;
                    delete s.state.fdc;
                },
            ],
            [
                "a snapshot from before touchscreen state was saved",
                (s) => {
                    s.version = 3;
                    delete s.state.touchScreen;
                },
            ],
            [
                "a pre-v3 snapshot, which never recorded a co-processor",
                (s) => {
                    s.version = 2;
                    delete s.coProcessor;
                },
            ],
            [
                "a snapshot with no teletext adaptor state into a machine with one",
                () => {},
                { hasTeletextAdaptor: true },
            ],
            [
                "a snapshot from before a disc's written tracks were saved",
                (s) => delete s.state.fdc.drives[0].disc.dirtyTracks,
                {},
                (machine) => machine.fdc.loadDisc(0, discOf(1)),
            ],
        ])("restores %s", async (_, mutate, config = {}, loadDisc = () => {}) => {
            loadDisc(cpu);
            const snapshot = createSnapshot(cpu, model);
            mutate(snapshot);
            const restored = machineWithRealChips(TEST_6502, config);
            await restored.initialise();
            loadDisc(restored);

            expect(() => restoreSnapshot(restored, model, snapshot)).not.toThrow();
        });
    });

    describe("snapshotToJSON / snapshotFromJSON", () => {
        it("carries a machine's whole state, nested typed arrays and all", () => {
            cpu.a = 0x42;
            cpu.pc = 0xd940;
            cpu.ramRomOs[0x7fff] = 0xcc;
            cpu.soundChip.registers[0] = 0x123;
            cpu.video.regs[0] = 127;
            cpu.sysvia.write(0x01, 0x55);
            const saved = createSnapshot(cpu, model);

            const cpu2 = machineWithRealChips(TEST_6502);
            restoreSnapshot(cpu2, model, snapshotFromJSON(snapshotToJSON(saved)));

            const stateOf = (machine) => JSON.parse(snapshotToJSON(createSnapshot(machine, model).state));
            expect(stateOf(cpu2)).toEqual(stateOf(cpu));
        });
    });

    describe("TypedArray encoding", () => {
        const encodingOf = (json, key) => JSON.parse(json)[key].encoding;

        function patterned(Constructor, length) {
            return Constructor.from({ length }, (_, i) => (i * 2654435761) % 997);
        }

        it("deflates an array of 1024 bytes or more and leaves a smaller one plain", () => {
            const json = snapshotToJSON({ small: new Uint8Array(1023), large: new Uint8Array(1024) });

            expect(encodingOf(json, "small")).toBeUndefined();
            expect(encodingOf(json, "large")).toBe("deflate");
        });

        it("round-trips plain and deflated arrays of every element size", () => {
            const original = {
                empty: new Uint8Array(0),
                small: patterned(Uint16Array, 8),
                bytes: patterned(Uint8Array, 4096),
                halves: patterned(Uint16Array, 1000),
                singles: patterned(Float32Array, 400).map((v) => v / 3),
                words: patterned(Uint32Array, 6000),
                signed: patterned(Int32Array, 300).map((v) => -v),
                doubles: patterned(Float64Array, 200).map((v) => v / 7),
                view: new Uint32Array(patterned(Uint32Array, 600).buffer, 4, 512),
            };

            const restored = snapshotFromJSON(snapshotToJSON(original));

            for (const [key, array] of Object.entries(original)) {
                expect(restored[key]).toBeInstanceOf(array.constructor);
                expect(restored[key]).toEqual(array);
            }
        });

        it("loads a version 3 snapshot, whose arrays are all plain base64", () => {
            cpu.a = 0x42;
            cpu.ramRomOs[0x200] = 0xdd;
            const snapshot = { ...createSnapshot(cpu, model), version: 3 };
            const v3Json = JSON.stringify(snapshot, (key, value) =>
                ArrayBuffer.isView(value)
                    ? {
                          __typedArray: true,
                          type: value.constructor.name,
                          data: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
                      }
                    : value,
            );

            const cpu2 = machineWithRealChips(TEST_6502);
            restoreSnapshot(cpu2, model, snapshotFromJSON(v3Json));

            expect(cpu2.a).toBe(0x42);
            expect(cpu2.ramRomOs[0x200]).toBe(0xdd);
        });

        it("refuses data that does not fill a whole number of elements", () => {
            const json = JSON.stringify({
                words: { __typedArray: true, type: "Uint32Array", data: btoa("\x01\x02\x03") },
            });

            expect(() => snapshotFromJSON(json)).toThrow(/not a multiple/);
        });

        it("refuses an encoding it does not know", () => {
            const json = JSON.stringify({
                ram: { __typedArray: true, type: "Uint8Array", encoding: "lzma", data: "" },
            });

            expect(() => snapshotFromJSON(json)).toThrow(/Unknown TypedArray encoding: lzma/);
        });
    });

    describe("touchscreen", () => {
        function selectPollingMode(machine) {
            for (const char of "M129.") machine.touchScreen.onTransmit(char.charCodeAt(0));
        }

        it("keeps reporting positions after a restore", () => {
            selectPollingMode(cpu);
            const snapshot = snapshotFromJSON(snapshotToJSON(createSnapshot(cpu, model)));

            const cpu2 = machineWithRealChips(TEST_6502);
            restoreSnapshot(cpu2, model, snapshot);
            cpu2.touchScreen.onMouse(0.5, 0.5, true);
            cpu2.scheduler.polltime(cpu2.touchScreen.pollCycles);

            expect(cpu2.touchScreen.tryReceive(true)).toBe(0x43);
        });
    });

    describe("sideways RAM", () => {
        const SidewaysRamBank = 4;

        function writeBank(machine, bank, value) {
            machine.romSelect(bank);
            machine.writemem(0x8000, value);
            machine.writemem(0xbfff, value);
        }

        function readBank(machine, bank) {
            machine.romSelect(bank);
            return [machine.readmem(0x8000), machine.readmem(0xbfff)];
        }

        it.each([
            ["kept in memory, as rewind keeps it", (snapshot) => snapshot],
            ["saved to a file", (snapshot) => snapshotFromJSON(snapshotToJSON(snapshot))],
        ])("puts back what a sideways RAM bank held when a snapshot %s was taken", (_, transport) => {
            writeBank(cpu, SidewaysRamBank, 0x5a);
            const snapshot = transport(createSnapshot(cpu, model));
            writeBank(cpu, SidewaysRamBank, 0xa5);

            restoreSnapshot(cpu, model, snapshot);

            expect(readBank(cpu, SidewaysRamBank)).toEqual([0x5a, 0x5a]);
        });

        it.each([
            ["a B", TEST_6502, 0x00ff, 8],
            ["a Master", TEST_65C12, 0x00f0, 4],
        ])("packs only the banks %s has as sideways RAM", (_, cpuModel, bankMask, banks) => {
            const { swram, swramBankMask } = machineWithRealChips(cpuModel).snapshotState();

            expect(swramBankMask).toBe(bankMask);
            expect(swram.length).toBe(banks * RomBankBytes);
        });

        it("puts each packed bank back where the mask says it came from", () => {
            const swram = new Uint8Array(2 * RomBankBytes);
            swram.fill(0x11, 0, RomBankBytes).fill(0x22, RomBankBytes);
            const snapshot = createSnapshot(cpu, model);
            Object.assign(snapshot.state, { swram, swramBankMask: (1 << 2) | (1 << 5) });
            writeBank(cpu, 3, 0xa5);

            restoreSnapshot(cpu, model, snapshot);

            expect([readBank(cpu, 2), readBank(cpu, 3), readBank(cpu, 5)]).toEqual([
                [0x11, 0x11],
                [0xa5, 0xa5],
                [0x22, 0x22],
            ]);
        });

        it("leaves the banks out of a snapshot that carries every ROM bank", () => {
            const state = cpu.snapshotState({ includeRoms: true });

            expect(state.roms).toBeDefined();
            expect(state.swram).toBeUndefined();
        });
    });

    describe("co-processor", () => {
        it("records that no co-processor was fitted", () => {
            expect(createSnapshot(cpu, model).coProcessor).toBe(false);
        });

        it("records a fitted co-processor and its state", () => {
            const tubeCpu = machineWithRealChips(TEST_6502, { tube: true });
            const snapshot = createSnapshot(tubeCpu, model);

            expect(snapshot.coProcessor).toBe(true);
            expect(snapshot.state.tube.ula).toBeDefined();
        });
    });

    describe("Teletext adaptor snapshot", () => {
        // The test model maps 0xfcxx as plain RAM, so the adaptor's registers are driven directly.
        const StatusRegister = 0x00;
        const RowRegister = 0x01;
        const DataRegister = 0x02;

        it("omits the adaptor when none is fitted", () => {
            expect(createSnapshot(cpu, model).state.teletextAdaptor).toBeUndefined();
        });

        it("round-trips the fitted adaptor's channel and frame buffer", async () => {
            const withAdaptor = machineWithRealChips(TEST_6502, { hasTeletextAdaptor: true });
            await withAdaptor.initialise();
            withAdaptor.teletextAdaptor.write(StatusRegister, 0x04 | 2); // Teletext enable, channel 2
            withAdaptor.teletextAdaptor.write(RowRegister, 3);
            withAdaptor.teletextAdaptor.write(DataRegister, 0xaa);

            const snapshot = createSnapshot(withAdaptor, model);
            const restored = machineWithRealChips(TEST_6502, { hasTeletextAdaptor: true });
            await restored.initialise();
            restoreSnapshot(restored, model, snapshot);

            expect(snapshot.state.teletextAdaptor.channel).toBe(2);
            restored.teletextAdaptor.write(RowRegister, 3);
            expect(restored.teletextAdaptor.read(DataRegister)).toBe(0xaa);
        });
    });

    describe("discs in a save file", () => {
        const write = (disc, isSideUpper, track, pulses) => {
            disc.writePulses(isSideUpper, track, 0, pulses);
            disc.flushWrites();
        };
        const savedDisc = (machine) =>
            snapshotFromJSON(snapshotToJSON(createSnapshot(machine, model))).state.fdc.drives[0].disc;
        const machineWith = (disc) => {
            const machine = machineWithRealChips(TEST_6502);
            machine.fdc.loadDisc(0, disc);
            return machine;
        };

        it("keeps only the tracks written since the disc went in, on either side", () => {
            const disc = discOf(2, true);
            cpu.fdc.loadDisc(0, disc);
            expect(savedDisc(cpu).dirtyTracks).toEqual({});

            write(disc, false, 0, 0x11111111);
            write(disc, true, 0, 0x22222222);
            const { tracks, dirtyTracks } = savedDisc(cpu);

            expect(tracks).toEqual({});
            expect(Object.keys(dirtyTracks).sort()).toEqual(["false:0", "true:0"]);
            expect(dirtyTracks["false:0"].pulses2Us[0]).toBe(0x11111111);
            expect(dirtyTracks["true:0"].pulses2Us[0]).toBe(0x22222222);
        });

        it("restores the written tracks over the disc reloaded from its source", () => {
            const disc = discOf(2, true);
            const cleanPulse = disc.getTrack(false, 1).pulses2Us[0];
            cpu.fdc.loadDisc(0, disc);
            write(disc, false, 0, 0x11111111);
            write(disc, true, 0, 0x22222222);
            const saved = snapshotFromJSON(snapshotToJSON(createSnapshot(cpu, model)));

            const restored = machineWith(discOf(2, true));
            restoreSnapshot(restored, model, saved);

            const reloaded = restored.fdc.drives[0].disc;
            expect(reloaded.getTrack(false, 0).pulses2Us[0]).toBe(0x11111111);
            expect(reloaded.getTrack(true, 0).pulses2Us[0]).toBe(0x22222222);
            expect(reloaded.getTrack(false, 1).pulses2Us[0]).toBe(cleanPulse);
        });

        it("keeps the tracks written around a rewind, and not one the rewind undid", () => {
            const disc = discOf(3);
            cpu.fdc.loadDisc(0, disc);
            write(disc, false, 0, 0x12345678);
            const captured = disc.snapshotState();
            write(disc, false, 1, 0xabcdef00);
            disc.restoreState(captured);
            write(disc, false, 2, 0x55555555);

            expect(Object.keys(savedDisc(cpu).dirtyTracks).sort()).toEqual(["false:0", "false:2"]);
        });

        it("keeps the tracks written before an earlier save, once that save is restored", () => {
            const disc = discOf(3);
            cpu.fdc.loadDisc(0, disc);
            write(disc, false, 0, 0xaaaaaaaa);
            const restored = machineWith(discOf(3));
            restoreSnapshot(restored, model, snapshotFromJSON(snapshotToJSON(createSnapshot(cpu, model))));

            write(restored.fdc.drives[0].disc, false, 1, 0xbbbbbbbb);
            const { dirtyTracks } = savedDisc(restored);

            expect(dirtyTracks["false:0"].pulses2Us[0]).toBe(0xaaaaaaaa);
            expect(dirtyTracks["false:1"].pulses2Us[0]).toBe(0xbbbbbbbb);
        });
    });
});

describe("isSameModel", () => {
    it.each([
        ["BBC B with 8271 (DFS 1.2)", "BBC B with 8271 (DFS 1.2)", true],
        ["B-DFS1.2", "BBC B with DFS 1.2", true],
        ["B-DFS0.9", "BBC B with DFS 0.9", true],
        ["B-DFS0.9", "B", true],
        ["B-DFS1.2", "B-DFS0.9", false],
        ["B1770", "B1770A", false],
        ["Master", "MasterADFS", false],
        ["Master", "MasterANFS", false],
        ["MasterADFS", "MasterANFS", false],
        ["B-DFS1.2", "B1770", false],
        ["B-DFS1.2", "Master", false],
        ["Nonexistent", "Master", false],
    ])("%j and %j are the same model: %s", (a, b, same) => {
        expect(isSameModel(a, b)).toBe(same);
    });
});

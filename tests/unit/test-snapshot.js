import { describe, it, expect, beforeEach } from "vitest";
import { createSnapshot, restoreSnapshot, snapshotToJSON, snapshotFromJSON, isSameModel } from "../../src/snapshot.js";
import { Video } from "../../src/video.js";
import { SoundChip } from "../../src/soundchip.js";
import { machineSpec, nullIo } from "../../src/machine-spec.js";
import { TEST_6502, TubeModel } from "../../src/models.js";
import { Disc, DiscConfig, loadSsd } from "../../src/disc.js";
import { typedArrayToBase64 } from "../../src/state-utils.js";

function makeCpu(config = {}) {
    const fb32 = new Uint32Array(1024 * 768);
    const video = new Video(false, fb32, () => {});
    const soundChip = new SoundChip(() => {});
    return new TEST_6502.Cpu(TEST_6502, { ...nullIo({ video, soundChip }), config: machineSpec(config) });
}

describe("Snapshot coordinator", () => {
    let cpu;
    const model = TEST_6502;

    beforeEach(async () => {
        cpu = makeCpu();
        await cpu.initialise();
    });

    describe("createSnapshot", () => {
        it("should create a snapshot with metadata", () => {
            const snapshot = createSnapshot(cpu, model);

            expect(snapshot.format).toBe("jsbeeb-snapshot");
            expect(snapshot.version).toBe(4);
            expect(snapshot.model).toBe(model.name);
            expect(snapshot.timestamp).toBeDefined();
            expect(snapshot.state).toBeDefined();
            expect(snapshot.state.a).toBeDefined();
            expect(snapshot.state.ram).toBeDefined();
        });
    });

    describe("restoreSnapshot", () => {
        it("should restore state from a snapshot", () => {
            cpu.a = 0x42;
            cpu.x = 0x10;
            cpu.ramRomOs[0x100] = 0xaa;

            const snapshot = createSnapshot(cpu, model);

            const cpu2 = makeCpu();
            restoreSnapshot(cpu2, model, snapshot);

            expect(cpu2.a).toBe(0x42);
            expect(cpu2.x).toBe(0x10);
            expect(cpu2.ramRomOs[0x100]).toBe(0xaa);
        });

        it("should throw on model mismatch", () => {
            const snapshot = createSnapshot(cpu, model);
            // Use a name that findModel won't resolve and doesn't match
            const otherModel = { name: "Completely Different Machine" };

            expect(() => restoreSnapshot(cpu, otherModel, snapshot)).toThrow(/Model mismatch/);
        });

        it("should throw on unknown format", () => {
            const snapshot = { format: "unknown", version: 1, model: model.name, state: {} };
            expect(() => restoreSnapshot(cpu, model, snapshot)).toThrow(/Unknown snapshot format/);
        });

        it("should throw on newer version", () => {
            const snapshot = createSnapshot(cpu, model);
            snapshot.version = 999;
            expect(() => restoreSnapshot(cpu, model, snapshot)).toThrow(/newer than supported/);
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

            const cpu2 = makeCpu();
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
                    ? { __typedArray: true, type: value.constructor.name, data: typedArrayToBase64(value) }
                    : value,
            );

            const cpu2 = makeCpu();
            restoreSnapshot(cpu2, model, snapshotFromJSON(v3Json));

            expect(cpu2.a).toBe(0x42);
            expect(cpu2.ramRomOs[0x200]).toBe(0xdd);
        });

        it("refuses an encoding it does not know", () => {
            const json = JSON.stringify({
                ram: { __typedArray: true, type: "Uint8Array", encoding: "lzma", data: "" },
            });

            expect(() => snapshotFromJSON(json)).toThrow(/Unknown TypedArray encoding: lzma/);
        });
    });

    describe("v1 backward compatibility", () => {
        it("should restore a v1 snapshot without FDC field", () => {
            const snapshot = createSnapshot(cpu, model);
            // Simulate a v1 snapshot by removing FDC and setting version to 1
            snapshot.version = 1;
            delete snapshot.state.fdc;

            const cpu2 = makeCpu();
            // Should not throw — FDC keeps its current state
            expect(() => restoreSnapshot(cpu2, model, snapshot)).not.toThrow();
        });
    });

    describe("touchscreen", () => {
        function selectPollingMode(machine) {
            for (const char of "M129.") machine.touchScreen.onTransmit(char.charCodeAt(0));
        }

        it("keeps reporting positions after a restore", () => {
            selectPollingMode(cpu);
            const snapshot = snapshotFromJSON(snapshotToJSON(createSnapshot(cpu, model)));

            const cpu2 = makeCpu();
            restoreSnapshot(cpu2, model, snapshot);
            cpu2.touchScreen.onMouse(0.5, 0.5, true);
            cpu2.scheduler.polltime(cpu2.touchScreen.pollCycles);

            expect(cpu2.touchScreen.tryReceive(true)).toBe(0x43);
        });

        it("restores a snapshot from before touchscreen state was saved", () => {
            const snapshot = createSnapshot(cpu, model);
            snapshot.version = 3;
            delete snapshot.state.touchScreen;

            expect(() => restoreSnapshot(makeCpu(), model, snapshot)).not.toThrow();
        });
    });

    describe("co-processor", () => {
        it("records that no co-processor was fitted", () => {
            expect(createSnapshot(cpu, model).coProcessor).toBe(false);
        });

        it("records a fitted co-processor and its state", () => {
            const tubeCpu = makeCpu({ tube: TubeModel });
            const snapshot = createSnapshot(tubeCpu, model);

            expect(snapshot.coProcessor).toBe(true);
            expect(snapshot.state.tube.ula).toBeDefined();
        });

        it("refuses to restore a host-only snapshot into a machine with a co-processor", () => {
            const snapshot = createSnapshot(cpu, model);

            expect(() => restoreSnapshot(makeCpu({ tube: TubeModel }), model, snapshot)).toThrow(
                /Co-processor mismatch/,
            );
        });

        it("refuses to restore a co-processor snapshot into a machine without one", () => {
            const snapshot = createSnapshot(makeCpu({ tube: TubeModel }), model);

            expect(() => restoreSnapshot(cpu, model, snapshot)).toThrow(/Co-processor mismatch/);
        });

        it("still loads pre-v3 snapshots, which never recorded a co-processor", () => {
            const snapshot = createSnapshot(cpu, model);
            snapshot.version = 2;
            delete snapshot.coProcessor;

            expect(() => restoreSnapshot(makeCpu(), model, snapshot)).not.toThrow();
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
            const withAdaptor = makeCpu({ hasTeletextAdaptor: true });
            await withAdaptor.initialise();
            withAdaptor.teletextAdaptor.write(StatusRegister, 0x04 | 2); // Teletext enable, channel 2
            withAdaptor.teletextAdaptor.write(RowRegister, 3);
            withAdaptor.teletextAdaptor.write(DataRegister, 0xaa);

            const snapshot = createSnapshot(withAdaptor, model);
            const restored = makeCpu({ hasTeletextAdaptor: true });
            await restored.initialise();
            restoreSnapshot(restored, model, snapshot);

            expect(snapshot.state.teletextAdaptor.channel).toBe(2);
            restored.teletextAdaptor.write(RowRegister, 3);
            expect(restored.teletextAdaptor.read(DataRegister)).toBe(0xaa);
        });

        it("leaves a fitted adaptor alone when the snapshot has no adaptor state", async () => {
            const snapshot = createSnapshot(cpu, model);
            const restored = makeCpu({ hasTeletextAdaptor: true });
            await restored.initialise();

            expect(() => restoreSnapshot(restored, model, snapshot)).not.toThrow();
        });
    });

    describe("discs in a save file", () => {
        const TrackBytes = 256 * 10;
        const discOf = (tracks, doubleSided = false) => {
            const image = new Uint8Array(TrackBytes * tracks * (doubleSided ? 2 : 1)).map((_, i) => i * 7);
            return loadSsd(new Disc(true, new DiscConfig(), "test.ssd"), image, doubleSided);
        };
        const write = (disc, isSideUpper, track, pulses) => {
            disc.writePulses(isSideUpper, track, 0, pulses);
            disc.flushWrites();
        };
        const savedDisc = (machine) =>
            snapshotFromJSON(snapshotToJSON(createSnapshot(machine, model))).state.fdc.drives[0].disc;
        const machineWith = (disc) => {
            const machine = makeCpu();
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

        it("restores a snapshot from before written tracks were saved", () => {
            cpu.fdc.loadDisc(0, discOf(1));
            const snapshot = createSnapshot(cpu, model);
            delete snapshot.state.fdc.drives[0].disc.dirtyTracks;

            expect(() => restoreSnapshot(machineWith(discOf(1)), model, snapshot)).not.toThrow();
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

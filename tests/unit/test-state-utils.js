import { describe, it, expect } from "vitest";
import { typedArrayToBase64, base64ToTypedArray, deepCopySnapshot } from "../../src/state-utils.js";

describe("typedArrayToBase64 / base64ToTypedArray", () => {
    it("should round-trip a Uint8Array", () => {
        const original = new Uint8Array([0, 1, 127, 128, 255]);
        const b64 = typedArrayToBase64(original);
        const restored = base64ToTypedArray(b64, Uint8Array);
        expect(restored).toEqual(original);
        expect(restored).toBeInstanceOf(Uint8Array);
    });

    it("should round-trip a Uint32Array", () => {
        const original = new Uint32Array([0, 1, 0x12345678, 0xdeadbeef, 0xffffffff]);
        const b64 = typedArrayToBase64(original);
        const restored = base64ToTypedArray(b64, Uint32Array);
        expect(restored).toEqual(original);
        expect(restored).toBeInstanceOf(Uint32Array);
    });

    it("should round-trip a Float32Array", () => {
        const original = new Float32Array([0, 1.5, -3.14, 1e10, Number.EPSILON]);
        const b64 = typedArrayToBase64(original);
        const restored = base64ToTypedArray(b64, Float32Array);
        expect(restored).toEqual(original);
        expect(restored).toBeInstanceOf(Float32Array);
    });

    it("should round-trip an Int32Array", () => {
        const original = new Int32Array([-2147483648, -1, 0, 1, 2147483647]);
        const b64 = typedArrayToBase64(original);
        const restored = base64ToTypedArray(b64, Int32Array);
        expect(restored).toEqual(original);
        expect(restored).toBeInstanceOf(Int32Array);
    });

    it("should round-trip an empty typed array", () => {
        const original = new Uint8Array([]);
        const b64 = typedArrayToBase64(original);
        const restored = base64ToTypedArray(b64, Uint8Array);
        expect(restored).toEqual(original);
        expect(restored.length).toBe(0);
    });

    it("should throw on misaligned base64 data", () => {
        // 3 bytes is not a valid Uint32Array (needs multiple of 4)
        const b64 = typedArrayToBase64(new Uint8Array([1, 2, 3]));
        expect(() => base64ToTypedArray(b64, Uint32Array)).toThrow(/not a multiple/);
    });
});

describe("deepCopySnapshot", () => {
    it("should copy primitive values as-is", () => {
        expect(deepCopySnapshot(42)).toBe(42);
        expect(deepCopySnapshot("hello")).toBe("hello");
        expect(deepCopySnapshot(true)).toBe(true);
        expect(deepCopySnapshot(null)).toBe(null);
        expect(deepCopySnapshot(undefined)).toBe(undefined);
    });

    it("should deep copy a plain object with typed arrays", () => {
        const original = {
            a: 1,
            b: "two",
            mem: new Uint8Array([10, 20, 30]),
            palette: new Uint32Array([0xff0000, 0x00ff00]),
        };
        const copy = deepCopySnapshot(original);

        expect(copy.a).toBe(1);
        expect(copy.b).toBe("two");
        expect(copy.mem).toEqual(original.mem);
        expect(copy.palette).toEqual(original.palette);

        // Verify isolation: mutating original should not affect copy
        original.mem[0] = 99;
        original.palette[0] = 0;
        expect(copy.mem[0]).toBe(10);
        expect(copy.palette[0]).toBe(0xff0000);
    });

    it("should deep copy nested objects", () => {
        const original = {
            cpu: { a: 1, x: 2 },
            via: {
                ora: 0xff,
                timers: new Uint32Array([100, 200]),
            },
        };
        const copy = deepCopySnapshot(original);

        original.cpu.a = 99;
        original.via.timers[0] = 999;
        expect(copy.cpu.a).toBe(1);
        expect(copy.via.timers[0]).toBe(100);
    });

    it("should deep copy arrays", () => {
        const original = {
            outputBit: [true, false, true, false],
            buffers: [new Uint8Array([1, 2]), new Uint8Array([3, 4])],
        };
        const copy = deepCopySnapshot(original);

        original.outputBit[0] = false;
        original.buffers[0][0] = 99;
        expect(copy.outputBit[0]).toBe(true);
        expect(copy.buffers[0][0]).toBe(1);
    });

    it("should handle a realistic snapshot structure", () => {
        const snapshot = {
            cpu: { a: 0x42, x: 0x10, y: 0x00, s: 0xff, pc: 0xd940 },
            ram: new Uint8Array(1024).fill(0xaa),
            scheduler: { epoch: 123456789 },
            sysvia: {
                ora: 0x7f,
                t1c: 5000,
                taskOffset: 1234,
            },
            video: {
                ulaPal: new Uint32Array(16),
                regs: new Uint8Array(32),
                ula: { collook: new Uint32Array(16) },
            },
        };

        const copy = deepCopySnapshot(snapshot);

        // Mutate everything in original
        snapshot.cpu.a = 0;
        snapshot.ram[0] = 0;
        snapshot.scheduler.epoch = 0;
        snapshot.sysvia.ora = 0;
        snapshot.video.ulaPal[0] = 0xdeadbeef;
        snapshot.video.ula.collook[0] = 0xdeadbeef;

        // Copy should be untouched
        expect(copy.cpu.a).toBe(0x42);
        expect(copy.ram[0]).toBe(0xaa);
        expect(copy.scheduler.epoch).toBe(123456789);
        expect(copy.sysvia.ora).toBe(0x7f);
        expect(copy.video.ulaPal[0]).toBe(0);
        expect(copy.video.ula.collook[0]).toBe(0);
    });
});

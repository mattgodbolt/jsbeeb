import { describe, it, expect } from "vitest";
import { RewindBuffer } from "../../src/rewind.js";

function makeSnapshot(id, ramValue = 0) {
    return {
        id,
        cpu: { a: id, x: 0 },
        ram: new Uint8Array([ramValue, ramValue, ramValue]),
    };
}

describe("RewindBuffer", () => {
    it("should start empty", () => {
        const buf = new RewindBuffer(5);
        expect(buf.length).toBe(0);
        expect(buf.pop()).toBeNull();
        expect(buf.peek()).toBeNull();
    });

    it("should push and pop a single snapshot", () => {
        const buf = new RewindBuffer(5);
        buf.push(makeSnapshot(1));
        expect(buf.length).toBe(1);

        const popped = buf.pop();
        expect(popped.id).toBe(1);
        expect(buf.length).toBe(0);
    });

    it("should pop in LIFO order", () => {
        const buf = new RewindBuffer(5);
        buf.push(makeSnapshot(1));
        buf.push(makeSnapshot(2));
        buf.push(makeSnapshot(3));

        expect(buf.pop().id).toBe(3);
        expect(buf.pop().id).toBe(2);
        expect(buf.pop().id).toBe(1);
        expect(buf.length).toBe(0);
    });

    it("should peek without removing", () => {
        const buf = new RewindBuffer(5);
        buf.push(makeSnapshot(1));
        buf.push(makeSnapshot(2));

        expect(buf.peek().id).toBe(2);
        expect(buf.length).toBe(2);
        expect(buf.peek().id).toBe(2); // Still there
    });

    it("should deep copy typed arrays on push", () => {
        const buf = new RewindBuffer(5);
        const snapshot = makeSnapshot(1, 0xaa);
        buf.push(snapshot);

        // Mutate the original
        snapshot.ram[0] = 0xff;
        snapshot.cpu.a = 99;

        // Buffer copy should be unaffected
        const stored = buf.peek();
        expect(stored.ram[0]).toBe(0xaa);
        expect(stored.cpu.a).toBe(1);
    });

    it("should overwrite oldest when full", () => {
        const buf = new RewindBuffer(3);
        buf.push(makeSnapshot(1));
        buf.push(makeSnapshot(2));
        buf.push(makeSnapshot(3));
        expect(buf.length).toBe(3);

        // Push a 4th - should overwrite snapshot 1
        buf.push(makeSnapshot(4));
        expect(buf.length).toBe(3);

        // Pop should return 4, 3, 2 (oldest 1 was overwritten)
        expect(buf.pop().id).toBe(4);
        expect(buf.pop().id).toBe(3);
        expect(buf.pop().id).toBe(2);
        expect(buf.length).toBe(0);
    });

    it("should handle wraparound correctly", () => {
        const buf = new RewindBuffer(3);
        // Fill and overflow multiple times
        for (let i = 1; i <= 10; i++) {
            buf.push(makeSnapshot(i));
        }
        expect(buf.length).toBe(3);

        // Should have the last 3 snapshots
        expect(buf.pop().id).toBe(10);
        expect(buf.pop().id).toBe(9);
        expect(buf.pop().id).toBe(8);
    });

    it("should clear all snapshots", () => {
        const buf = new RewindBuffer(5);
        buf.push(makeSnapshot(1));
        buf.push(makeSnapshot(2));
        buf.push(makeSnapshot(3));

        buf.clear();
        expect(buf.length).toBe(0);
        expect(buf.pop()).toBeNull();
    });

    it("should work correctly after clear and re-fill", () => {
        const buf = new RewindBuffer(3);
        buf.push(makeSnapshot(1));
        buf.push(makeSnapshot(2));
        buf.clear();

        buf.push(makeSnapshot(10));
        buf.push(makeSnapshot(20));
        expect(buf.length).toBe(2);
        expect(buf.pop().id).toBe(20);
        expect(buf.pop().id).toBe(10);
    });

    it("should handle alternating push/pop", () => {
        const buf = new RewindBuffer(5);
        buf.push(makeSnapshot(1));
        buf.push(makeSnapshot(2));
        expect(buf.pop().id).toBe(2);

        buf.push(makeSnapshot(3));
        buf.push(makeSnapshot(4));
        expect(buf.pop().id).toBe(4);
        expect(buf.pop().id).toBe(3);
        expect(buf.pop().id).toBe(1);
        expect(buf.length).toBe(0);
    });
});

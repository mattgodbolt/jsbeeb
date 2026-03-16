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

    it("should store snapshots directly without copying", () => {
        const buf = new RewindBuffer(5);
        const snapshot = makeSnapshot(1, 0xaa);
        buf.push(snapshot);

        // Buffer stores the same object (no deep copy — caller is
        // responsible for providing pre-cloned snapshots)
        const stored = buf.peek();
        expect(stored).toBe(snapshot);
        expect(stored.ram[0]).toBe(0xaa);
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

    describe("getAll", () => {
        it("should return empty array when buffer is empty", () => {
            const buf = new RewindBuffer(5);
            expect(buf.getAll()).toEqual([]);
        });

        it("should return snapshots oldest to newest", () => {
            const buf = new RewindBuffer(5);
            buf.push(makeSnapshot(1));
            buf.push(makeSnapshot(2));
            buf.push(makeSnapshot(3));

            const all = buf.getAll();
            expect(all).toHaveLength(3);
            expect(all[0].id).toBe(1);
            expect(all[1].id).toBe(2);
            expect(all[2].id).toBe(3);
        });

        it("should return correct order after wraparound", () => {
            const buf = new RewindBuffer(3);
            for (let i = 1; i <= 5; i++) buf.push(makeSnapshot(i));

            const all = buf.getAll();
            expect(all).toHaveLength(3);
            expect(all[0].id).toBe(3);
            expect(all[1].id).toBe(4);
            expect(all[2].id).toBe(5);
        });

        it("should not modify the buffer", () => {
            const buf = new RewindBuffer(5);
            buf.push(makeSnapshot(1));
            buf.push(makeSnapshot(2));
            buf.getAll();
            expect(buf.length).toBe(2);
            expect(buf.peek().id).toBe(2);
        });
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

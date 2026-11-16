import { describe, expect, it } from "vitest";

import { GuestMemory } from "../../src/vdfs-guest-memory.js";
import { fakeCpu, poke, putString } from "../helpers/vdfs.js";

const memoryOf = (options) => {
    const cpu = fakeCpu(options);
    return { cpu, guest: new GuestMemory(cpu) };
};

describe("the 6502's memory, as VDFS reaches it", () => {
    describe("numbers", () => {
        it("reads and writes bytes, words and longs low byte first", () => {
            const { cpu, guest } = memoryOf();
            guest.setLong(0x70, 0xdeadbeef);
            expect([...cpu.memory.subarray(0x70, 0x74)]).toEqual([0xef, 0xbe, 0xad, 0xde]);
            expect(guest.long(0x70)).toBe(0xdeadbeef);
            expect(guest.word(0x72)).toBe(0xdead);
            expect(guest.byte(0x73)).toBe(0xde);
        });

        it("wraps a number that runs off the top of memory, as the 6502's addressing does", () => {
            const { guest } = memoryOf();
            guest.setLong(0xfffe, 0x04030201);
            expect(guest.word(0xfffe)).toBe(0x0201);
            expect(guest.word(0)).toBe(0x0403);
        });
    });

    describe("text", () => {
        it("runs to a return, and no further than 255 characters", () => {
            const { cpu, guest } = memoryOf();
            putString(cpu, 0x2000, "HELLO WORLD");
            expect(guest.text(0x2000)).toBe("HELLO WORLD");
            poke(cpu, 0x3000, new Array(300).fill("A"));
            expect(guest.text(0x3000).length).toBe(255);
        });

        it.each([
            ["a space, where the OS leaves the rest of the line", "GREET 3000 +5", "GREET"],
            ["a return", "GREET", "GREET"],
            ["a closing quote, in which a space is part of the name", '"MY GAME" 3000', "MY GAME"],
        ])("ends a filename at %s", (_, line, expected) => {
            const { cpu, guest } = memoryOf();
            putString(cpu, 0x2000, line);
            expect(guest.filename(0x2000)).toBe(expected);
        });
    });

    describe("what may be loaded and saved", () => {
        it.each([
            ["a block in the middle of memory", 0x1900, 0x100, true, undefined],
            ["a block that ends at the top", 0xff00, 0x100, false, undefined],
            ["nothing at all, wherever it is", 0xfd00, 0, true, undefined],
            ["a read of the devices, which is not a change to them", 0xfc00, 0x100, false, undefined],
            ["a write over the devices", 0xfbff, 2, true, "Bad address"],
            ["a write inside them", 0xfe40, 1, true, "Bad address"],
            ["a block that runs past the top", 0xffff, 2, false, "Bad address"],
            ["more than the machine has", 0, 0x10001, false, "Bad address"],
        ])("takes %s", (_, address, length, writing, error) => {
            const { guest } = memoryOf();
            const attempt = () =>
                writing ? guest.write(address, new Uint8Array(length)) : guest.read(address, length);
            if (error) expect(attempt).toThrow(error);
            else expect(attempt).not.toThrow();
        });

        it("reads what was written, and a block loaded at an address the OS names with all ones above it", () => {
            const { cpu, guest } = memoryOf();
            guest.write(0xffff1900, Uint8Array.of(1, 2, 3));
            expect([...guest.read(0x1900, 3)]).toEqual([1, 2, 3]);
            expect(cpu.memory[0x1901]).toBe(2);
        });

        it("serves the I/O processor only, when there is a second processor", () => {
            const { guest } = memoryOf({ hasTube: true });
            expect(() => guest.read(0xffff1900, 1)).not.toThrow();
            expect(() => guest.read(0x00001900, 1)).toThrow("Tube");
            expect(() => guest.address(0x00002000)).toThrow("Tube");
            expect(guest.address(0xffff2000)).toBe(0x2000);
        });
    });
});

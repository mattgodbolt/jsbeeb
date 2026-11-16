import { describe, expect, it } from "vitest";

import { Channel, ChannelTable, FirstHandle, LastHandle } from "../../src/vdfs-channels.js";

const info = { load: 0, exec: 0, locked: false };
const channelWith = (bytes, { writable = true, path = ["F"] } = {}) =>
    new Channel({ path, data: Uint8Array.from(bytes), info, writable });

describe("VDFS channels", () => {
    describe("a channel", () => {
        it("reads a byte at a time, says when there are no more, and will not read beyond that", () => {
            const channel = channelWith([1, 2], { writable: false });
            expect([channel.readByte(), channel.readByte(), channel.readByte()]).toEqual([1, 2, undefined]);
            expect(channel.atEnd).toBe(true);
            channel.pointer = 3;
            expect(() => channel.readByte()).toThrow("EOF");
        });

        it("peeks at the next bytes, as many as the file has, without moving on", () => {
            const channel = channelWith([1, 2, 3], { writable: false });
            channel.pointer = 1;
            expect([...channel.peek(10)]).toEqual([2, 3]);
            expect(channel.pointer).toBe(1);
            channel.pointer = 5;
            expect([...channel.peek(10)]).toEqual([]);
        });

        it("writes over what is there, grows the file, and zero-fills a gap a seek left", () => {
            const channel = channelWith([1, 2]);
            channel.write(Uint8Array.of(9));
            channel.pointer = 4;
            channel.writeByte(7);
            expect([...channel.bytes]).toEqual([9, 2, 0, 0, 7]);
            expect(channel.pointer).toBe(5);
            expect(channel.dirty).toBe(true);
        });

        it("shortens a file, and zero-fills what it grows by afterwards", () => {
            const channel = channelWith([1, 2, 3]);
            channel.setLength(1);
            channel.setLength(3);
            expect([...channel.bytes]).toEqual([1, 0, 0]);
        });

        it("will not write, or change the extent of, a file that is open for reading", () => {
            const channel = channelWith([1], { writable: false });
            for (const refused of [
                () => channel.write(Uint8Array.of(1)),
                () => channel.writeByte(1),
                () => channel.setLength(5),
            ])
                expect(refused).toThrow("Locked");
            expect(channel.dirty).toBe(false);
        });

        it("will not let a file grow past 16 MB, and leaves it as it was", () => {
            const channel = channelWith([1]);
            expect(() => channel.setLength(0x1000001)).toThrow("File too big");
            channel.pointer = 0x1000000;
            expect(() => channel.writeByte(1)).toThrow("File too big");
            expect(channel.length).toBe(1);
        });
    });

    describe("the table", () => {
        it("gives handles from the first, and says Too many open files after the last", () => {
            const table = new ChannelTable();
            const handles = Array.from({ length: LastHandle - FirstHandle + 1 }, () => table.open(channelWith([1])));
            expect(handles).toEqual(Array.from({ length: 8 }, (_, index) => FirstHandle + index));
            expect(() => table.requireRoom()).toThrow("Too many open files");
            expect(() => table.open(channelWith([1]))).toThrow("Too many open files");
        });

        it("says Channel for a handle that is not open, or has been closed", () => {
            const table = new ChannelTable();
            expect(() => table.get(FirstHandle)).toThrow("Channel");
            const handle = table.open(channelWith([1]));
            table.take(handle);
            expect(() => table.get(handle)).toThrow("Channel");
            expect(() => table.take(handle)).toThrow("Channel");
        });

        it("reuses the lowest handle that is free", () => {
            const table = new ChannelTable();
            const [first, second] = [table.open(channelWith([1])), table.open(channelWith([2]))];
            table.take(first);
            expect(table.open(channelWith([3]))).toBe(first);
            expect(table.get(second).bytes[0]).toBe(2);
        });

        it("gives every open file when they are all closed, and then has none", () => {
            const table = new ChannelTable();
            const channels = [channelWith([1]), channelWith([2])];
            channels.forEach((channel) => table.open(channel));
            expect(table.all()).toEqual(channels);
            expect(table.takeAll()).toEqual(channels);
            expect(table.all()).toEqual([]);
        });

        it("says that the file at a path is no longer what a channel holds, whatever the case of its name", () => {
            const table = new ChannelTable();
            const deleted = channelWith([1], { path: ["Games", "Elite"] });
            const other = channelWith([1], { path: ["Games", "Zalaga"] });
            table.open(deleted);
            table.open(other);
            table.detachPath(["GAMES", "ELITE"]);
            expect([deleted.detached, other.detached]).toEqual([true, false]);
        });
    });
});

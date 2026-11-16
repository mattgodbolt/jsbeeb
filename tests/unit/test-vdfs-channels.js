import { describe, expect, it } from "vitest";

import { Channel, ChannelTable, FirstHandle, LastHandle } from "../../src/vdfs-channels.js";
import { Entry, VdfsVolume } from "../../src/vdfs-volume.js";
import { MemoryStore } from "../helpers/vdfs.js";

const entryWith = (...bytes) => new Entry("F", { data: Uint8Array.from(bytes) });

describe("VDFS channels", () => {
    describe("a channel", () => {
        it("reads a byte at a time, says when there are no more, and will not read beyond that", () => {
            const channel = new Channel(entryWith(1, 2), { writable: false });
            expect([channel.readByte(), channel.readByte(), channel.readByte()]).toEqual([1, 2, undefined]);
            expect(channel.atEnd).toBe(true);
            channel.pointer = 3;
            expect(() => channel.readByte()).toThrow("EOF");
        });

        it("peeks at the next bytes, as many as the file has, without moving on", () => {
            const channel = new Channel(entryWith(1, 2, 3), { writable: false });
            channel.pointer = 1;
            expect([...channel.peek(10)]).toEqual([2, 3]);
            expect(channel.pointer).toBe(1);
            channel.pointer = 5;
            expect([...channel.peek(10)]).toEqual([]);
        });

        it("writes over what is there, grows the file, and zero-fills a gap a seek left", () => {
            const channel = new Channel(entryWith(1, 2), { writable: true });
            channel.write(Uint8Array.of(9));
            channel.pointer = 4;
            channel.writeByte(7);
            expect([...channel.entry.bytes]).toEqual([9, 2, 0, 0, 7]);
            expect(channel.pointer).toBe(5);
            expect(channel.dirty).toBe(true);
        });

        it("will not write, or change the extent of, a file that is open for reading", () => {
            const channel = new Channel(entryWith(1), { writable: false });
            for (const refused of [
                () => channel.write(Uint8Array.of(1)),
                () => channel.writeByte(1),
                () => channel.setLength(5),
            ])
                expect(refused).toThrow("Locked");
            expect(channel.dirty).toBe(false);
        });

        it("will not let a file grow past 16 MB, and leaves it as it was", () => {
            const channel = new Channel(entryWith(1), { writable: true });
            expect(() => channel.setLength(0x1000001)).toThrow("File too big");
            channel.pointer = 0x1000000;
            expect(() => channel.writeByte(1)).toThrow("File too big");
            expect(channel.length).toBe(1);
        });
    });

    describe("the table", () => {
        const tableOf = async () => {
            const store = new MemoryStore();
            const volume = await VdfsVolume.open(store);
            return { store, volume, table: new ChannelTable(volume) };
        };

        it("gives handles from the first, and says Too many open files after the last", async () => {
            const { table } = await tableOf();
            const handles = Array.from({ length: LastHandle - FirstHandle + 1 }, () =>
                table.open(entryWith(1), { writable: false }),
            );
            expect(handles).toEqual(Array.from({ length: 8 }, (_, index) => FirstHandle + index));
            expect(() => table.open(entryWith(1), { writable: false })).toThrow("Too many open files");
        });

        it("says Channel for a handle that is not open, or has been closed", async () => {
            const { table } = await tableOf();
            expect(() => table.get(FirstHandle)).toThrow("Channel");
            const handle = table.open(entryWith(1), { writable: false });
            table.close(handle);
            expect(() => table.get(handle)).toThrow("Channel");
        });

        it("hands a written file to the store when it is closed, and not one that was only read", async () => {
            const { store, volume, table } = await tableOf();
            const written = volume.createFile(volume.root, "OUT");
            const read = volume.createFile(volume.root, "IN", { data: Uint8Array.of(1) });
            const writing = table.open(written, { writable: true, dirty: false });
            const reading = table.open(read, { writable: false, dirty: false });
            table.get(writing).writeByte(5);
            table.get(reading).readByte();
            table.close(writing);
            table.close(reading);
            await volume.flush();
            expect(store.log).toEqual([["writeFile", "OUT"]]);
        });

        it("hands over what is written on a flush, once, leaving the file open", async () => {
            const { store, volume, table } = await tableOf();
            const handle = table.open(volume.createFile(volume.root, "OUT"), { writable: true, dirty: false });
            table.get(handle).writeByte(5);
            table.flush();
            table.flush();
            await volume.flush();
            expect(store.log).toEqual([["writeFile", "OUT"]]);
            expect(() => table.get(handle)).not.toThrow();
        });

        it("closes every file, handing over what was written", async () => {
            const { store, volume, table } = await tableOf();
            const handle = table.open(volume.createFile(volume.root, "OUT"), { writable: true, dirty: true });
            table.closeAll();
            await volume.flush();
            expect(store.log).toEqual([["writeFile", "OUT"]]);
            expect(() => table.get(handle)).toThrow("Channel");
        });
    });
});

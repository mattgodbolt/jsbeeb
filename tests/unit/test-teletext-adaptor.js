import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { TeletextAdaptor } from "../../src/teletext_adaptor.js";
import * as loader from "../../src/loader.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

const TeletextIrq = 1 << 5;
const Status = 0;
const Row = 1;
const Data = 2;
const ClearStatus = 3;
const Enable = 0x04;
const Interrupts = 0x08;
const DataReady = 0xd0;
const FrameSize = 860;
const RowSize = 43;
const FirstRowOffset = 3 * RowSize;
const PollThresholdCycles = 50000;
const CyclesPerField = PollThresholdCycles + 1;
const GraceFields = 10;

/**
 * A broadcast whose every byte in frame f reads `channel * 16 + f + 1`, so a row shows which
 * stream and frame it came from; row 15 is left out of every frame.
 */
function broadcast(channel, frames, extraBytes = 0) {
    const data = new Uint8Array(frames * FrameSize + extraBytes);
    for (let frame = 0; frame < frames; frame++) {
        data.fill(channel * 16 + frame + 1, frame * FrameSize, (frame + 1) * FrameSize);
        data[frame * FrameSize + FirstRowOffset + 15 * RowSize] = 0;
    }
    return data;
}

describe("TeletextAdaptor", () => {
    let cpu;
    let adaptor;
    let pending;
    let loadData;

    const irq = () => (cpu.interrupt & TeletextIrq) !== 0;
    const dataReady = (target = adaptor) => target.read(Status) & DataReady;
    const nextField = (target = adaptor) => target.polltime(CyclesPerField);
    const readRow = (row, length, target = adaptor) => {
        target.write(Row, row);
        return Array.from({ length }, () => target.read(Data));
    };
    const sendChannel = (channel, frames, extraBytes) =>
        pending.get(`teletext/txt${channel}.dat`).resolve(broadcast(channel, frames, extraBytes));
    const failChannel = (channel, error) => pending.get(`teletext/txt${channel}.dat`).reject(error);
    const settle = () => new Promise((resolve) => setTimeout(resolve));
    const listenForNotices = () => {
        const notices = [];
        adaptor.addEventListener("notice", (e) => notices.push(e.detail));
        return notices;
    };

    beforeEach(() => {
        pending = new Map();
        loadData = vi
            .spyOn(loader, "loadData")
            .mockImplementation((url) => new Promise((resolve, reject) => pending.set(url, { resolve, reject })));
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        cpu = { interrupt: 0, resetLine: true };
        adaptor = new TeletextAdaptor(cpu);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("registers", () => {
        it("powers on with the links floating high, nothing latched and the row register reading zero", () => {
            expect(adaptor.read(Status)).toBe(0x0f);
            expect(adaptor.read(Row)).toBe(0);
        });

        it("reads a row back from its start each time the row is selected", () => {
            adaptor.write(Row, 5);
            adaptor.write(Data, 0xaa);
            adaptor.write(Data, 0x1bb);
            expect(readRow(5, 3)).toEqual([0xaa, 0xbb, 0]);
        });

        it.each([
            ["reading", () => adaptor.read(ClearStatus)],
            ["writing", () => adaptor.write(ClearStatus, 0)],
        ])("clears the latches and the IRQ on %s the clear register", (_, clear) => {
            adaptor.write(Status, Interrupts);
            nextField();
            expect([dataReady(), irq()]).toEqual([DataReady, true]);
            clear();
            expect([dataReady(), irq()]).toEqual([0, false]);
        });

        it("raises its IRQ only while interrupts are enabled", () => {
            nextField();
            expect([dataReady(), irq()]).toEqual([DataReady, false]);
            adaptor.write(Status, Interrupts);
            expect(irq()).toBe(true);
            adaptor.write(Status, 0);
            expect(irq()).toBe(false);
        });
    });

    describe("fields", () => {
        it("latches data ready once a field's worth of cycles has passed", () => {
            adaptor.polltime(PollThresholdCycles);
            expect(dataReady()).toBe(0);
            adaptor.polltime(1);
            expect(dataReady()).toBe(DataReady);
        });

        it("holds off while the CPU is in reset, and for ten fields afterwards", () => {
            cpu.resetLine = false;
            nextField();
            cpu.resetLine = true;
            adaptor.polltime((GraceFields + 1) * PollThresholdCycles);
            expect(dataReady()).toBe(0);
            adaptor.polltime(1);
            expect(dataReady()).toBe(DataReady);
        });

        it("starts each field's data at the top of row 0", () => {
            adaptor.write(Row, 0);
            adaptor.write(Data, 0x42);
            adaptor.write(Row, 5);
            adaptor.write(Data, 0x55);
            nextField();
            expect(adaptor.read(Data)).toBe(0x42);
        });
    });

    describe("broadcast", () => {
        it("shows a frame per field once enabled, wrapping at the end of the stream", async () => {
            adaptor.write(Status, Enable | 1);
            sendChannel(1, 2);
            await settle();
            const rows = [];
            for (let field = 0; field < 3; field++) {
                nextField();
                rows.push(readRow(0, 3));
            }
            expect(rows).toEqual([
                [0x67, 0x11, 0x11],
                [0x67, 0x12, 0x12],
                [0x67, 0x11, 0x11],
            ]);
        });

        it("reads a row the broadcast leaves out as blank", async () => {
            adaptor.write(Row, 15);
            adaptor.write(Data, 0x67);
            adaptor.write(Status, Enable | 1);
            sendChannel(1, 1);
            await settle();
            nextField();
            expect(readRow(15, 1)).toEqual([0]);
        });

        it("keeps the fields coming but shows nothing while disabled", async () => {
            adaptor.write(Status, Enable | 1);
            sendChannel(1, 1);
            await settle();
            adaptor.write(Status, 1);
            nextField();
            expect([dataReady(), ...readRow(0, 2)]).toEqual([DataReady, 0, 0]);
        });

        it("keeps running when enabled before the stream has loaded", () => {
            adaptor.write(Status, Enable | Interrupts);
            nextField();
            expect([dataReady(), irq(), ...readRow(0, 2)]).toEqual([DataReady, true, 0, 0]);
        });

        it("fetches a channel only when enabled on a different one", () => {
            adaptor.write(Status, 2);
            adaptor.write(Status, Enable);
            adaptor.write(Status, Enable | 1);
            adaptor.write(Status, Enable | 1);
            expect(loadData.mock.calls).toEqual([["teletext/txt1.dat"]]);
        });

        it("ignores a response that arrives after a newer channel's", async () => {
            adaptor.write(Status, Enable | 1);
            adaptor.write(Status, Enable | 2);
            sendChannel(2, 1);
            sendChannel(1, 1);
            await settle();
            nextField();
            expect(readRow(0, 2)).toEqual([0x67, 0x21]);
        });

        it("rounds a truncated stream down to whole frames", async () => {
            adaptor.write(Status, Enable | 1);
            sendChannel(1, 2, 100);
            await settle();
            for (let field = 0; field < 3; field++) nextField();
            expect(readRow(0, 2)).toEqual([0x67, 0x11]);
        });

        it("reports a failed load, saying which channel and why", async () => {
            const notices = listenForNotices();
            adaptor.write(Status, Enable | 1);
            failChannel(1, new Error("http code 404"));
            await settle();
            expect(notices).toHaveLength(1);
            expect(notices[0].message).toContain("channel 1");
            expect(notices[0].message).toContain("http code 404");
        });

        it("does not report a failure from a superseded request", async () => {
            const notices = listenForNotices();
            adaptor.write(Status, Enable | 1);
            adaptor.write(Status, Enable | 2);
            failChannel(1, new Error("404"));
            sendChannel(2, 1);
            await settle();
            nextField();
            expect(notices).toEqual([]);
            expect(readRow(0, 2)).toEqual([0x67, 0x21]);
        });
    });

    describe("reset", () => {
        it("does nothing on a soft reset", () => {
            adaptor.write(Status, Interrupts);
            nextField();
            adaptor.reset(false);
            expect([dataReady(), irq(), loadData.mock.calls]).toEqual([DataReady, true, []]);
        });

        it("clears everything and returns to channel 0 on a hard reset", async () => {
            adaptor.write(Status, Enable | Interrupts | 1);
            sendChannel(1, 1);
            await settle();
            nextField();
            expect([irq(), ...readRow(0, 2)]).toEqual([true, 0x67, 0x11]);

            adaptor.reset(true);

            expect([adaptor.read(Status), irq(), ...readRow(0, 2)]).toEqual([0x0f, false, 0, 0]);
            expect(loadData).toHaveBeenLastCalledWith("teletext/txt0.dat");
            sendChannel(0, 1);
            await settle();
            nextField();
            expect([irq(), ...readRow(0, 2)]).toEqual([false, 0, 0]);
        });

        it("discards a fetch still in flight over a hard reset", async () => {
            adaptor.write(Status, Enable | 1);
            adaptor.reset(true);
            sendChannel(0, 1);
            sendChannel(1, 1);
            await settle();
            adaptor.write(Status, Enable);
            nextField();
            expect(readRow(0, 2)).toEqual([0x67, 0x01]);
        });
    });

    describe("snapshots", () => {
        let restoredCpu;
        let restored;

        beforeEach(() => {
            restoredCpu = { interrupt: 0, resetLine: true };
            restored = new TeletextAdaptor(restoredCpu);
        });

        it("round-trips an adaptor on another channel, part way through writing a row", async () => {
            await expectSnapshotRoundTrips(
                () => new TeletextAdaptor({ interrupt: 0, resetLine: true }),
                (target) => {
                    target.write(Status, Enable | Interrupts | 2);
                    nextField(target);
                    target.write(Row, 3);
                    target.write(Data, 0xaa);
                    target.write(Data, 0xbb);
                    target.polltime(1234);
                },
            );
        });

        it("reasserts an IRQ the adaptor was holding", () => {
            adaptor.write(Status, Interrupts);
            nextField();
            restored.restoreState(adaptor.snapshotState());
            expect(restoredCpu.interrupt & TeletextIrq).toBe(TeletextIrq);
        });

        it("clears an IRQ the adaptor was not holding", () => {
            nextField();
            restoredCpu.interrupt = TeletextIrq;
            restored.restoreState(adaptor.snapshotState());
            expect(restoredCpu.interrupt & TeletextIrq).toBe(0);
        });

        it("does not share the frame buffer with the snapshot it came from", () => {
            adaptor.write(Row, 3);
            adaptor.write(Data, 0xaa);
            const state = adaptor.snapshotState();

            restored.restoreState(state);
            restored.write(Row, 3);
            restored.write(Data, 0x55);

            expect(readRow(3, 1)).toEqual([0xaa]);
            expect(state.frameBuffer[3][0]).toBe(0xaa);
        });

        it("refetches the stream when the restored channel differs", () => {
            adaptor.write(Status, Enable | 2);
            loadData.mockClear();
            restored.restoreState(adaptor.snapshotState());
            expect(loadData.mock.calls).toEqual([["teletext/txt2.dat"]]);
        });

        it("leaves the loaded stream alone when the channel is unchanged", () => {
            restored.restoreState(adaptor.snapshotState());
            expect(loadData).not.toHaveBeenCalled();
        });
    });
});

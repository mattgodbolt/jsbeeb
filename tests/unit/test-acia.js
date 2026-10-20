import { describe, it, expect, vi, afterEach } from "vitest";
import { Acia } from "../../src/acia.js";
import { Scheduler } from "../../src/scheduler.js";
import { findModel } from "../../src/models.js";
import { expectSnapshotRoundTrips } from "../helpers/snapshot-round-trip.js";

const BbcModel = findModel("B-DFS1.2");

// Control register word select 101: 8 data bits, 1 stop bit, no parity.
const EightBitsOneStopNoParity = 0x14;
// Control register word select 000: 7 data bits, 2 stop bits, even parity.
const SevenBitsTwoStopEvenParity = 0x00;
const TransmitInterruptEnable = 0x20;
const Tdre = 0x02;
const Rdrf = 0x01;
const ReceiveInterruptEnable = 0x80;
const CarrierPollsToRaiseDcd = 209;
const AciaIrq = 0x04;
// A 10 bit byte at 75 baud takes 0.1333s: 266666 cycles of the 2MHz clock.
const ByteCyclesAt75Baud = 266666;

function createScheduledAcia(scheduler, cr, transmitRate, model = BbcModel) {
    const cpu = { interrupt: 0, model };
    const acia = new Acia(cpu, { mute: vi.fn(), tone: vi.fn() }, scheduler);
    acia.write(0, cr);
    acia.setSerialTransmit(transmitRate);
    return { cpu, acia };
}

function createAcia(relayNoise) {
    const scheduler = new Scheduler();
    const acia = new Acia({ interrupt: 0, model: BbcModel }, { mute: vi.fn(), tone: vi.fn() }, scheduler, relayNoise);
    acia.setRs423Handler({});
    return { acia, scheduler };
}

describe("Acia", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("setMotor relay noise", () => {
        it("should trigger relay click on motor state transitions", () => {
            const relayNoise = { motorOn: vi.fn(), motorOff: vi.fn() };
            const { acia } = createAcia(relayNoise);

            acia.setMotor(true);
            expect(relayNoise.motorOn).toHaveBeenCalledOnce();
            expect(relayNoise.motorOff).not.toHaveBeenCalled();

            relayNoise.motorOn.mockClear();
            acia.setMotor(false);
            expect(relayNoise.motorOff).toHaveBeenCalledOnce();
            expect(relayNoise.motorOn).not.toHaveBeenCalled();
        });

        it("should not trigger relay click when motor state is unchanged", () => {
            const relayNoise = { motorOn: vi.fn(), motorOff: vi.fn() };
            const { acia } = createAcia(relayNoise);

            acia.setMotor(false); // already off
            expect(relayNoise.motorOn).not.toHaveBeenCalled();
            expect(relayNoise.motorOff).not.toHaveBeenCalled();

            acia.setMotor(true);
            relayNoise.motorOn.mockClear();
            acia.setMotor(true); // already on
            expect(relayNoise.motorOn).not.toHaveBeenCalled();
        });
    });

    describe("the recorder's PLAY latch", () => {
        const TapePollCycles = 100;

        const withTape = () => {
            const { acia, scheduler } = createAcia({ motorOn: () => {}, motorOff: () => {} });
            const tape = { poll: vi.fn(() => TapePollCycles), rewind: vi.fn() };
            acia.setTape(tape);
            const isPolled = (polledTape = tape) => {
                const before = polledTape.poll.mock.calls.length;
                scheduler.polltime(TapePollCycles);
                return polledTape.poll.mock.calls.length > before;
            };
            const nothingBooked = () => scheduler.headroom() === Scheduler.MaxHeadroom;
            return { acia, tape, scheduler, isPolled, nothingBooked };
        };

        it("runs the tape from the relay alone, PLAY being down to begin with", () => {
            const { acia, isPolled } = withTape();
            expect(acia.playPressed).toBe(true);
            acia.setMotor(true);
            expect(acia.tapeRunning).toBe(true);
            expect(isPolled()).toBe(true);
        });

        it("holds the tape still while STOP is down, whatever the relay does", () => {
            const { acia, isPolled, nothingBooked } = withTape();
            acia.setMotor(true);
            acia.pressStop();
            expect(acia.tapeRunning).toBe(false);
            expect(nothingBooked()).toBe(true);
            expect(isPolled()).toBe(false);
            acia.setMotor(false);
            acia.setMotor(true);
            expect(isPolled()).toBe(false);
            acia.pressPlay();
            expect(acia.tapeRunning).toBe(true);
            expect(isPolled()).toBe(true);
        });

        it("starts a tape put in while the relay is on, and stops when it is taken out", () => {
            const { acia, isPolled, nothingBooked } = withTape();
            acia.setMotor(true);
            const another = { poll: vi.fn(() => TapePollCycles), rewind: vi.fn() };
            acia.setTape(another);
            expect(another.poll).toHaveBeenCalled();
            expect(isPolled(another)).toBe(true);
            acia.setTape(undefined);
            expect(acia.tapeRunning).toBe(false);
            expect(nothingBooked()).toBe(true);
            expect(isPolled(another)).toBe(false);
        });

        it("leaves a tape put in with the relay off until the relay comes on, then polls it when it asks", () => {
            const { acia, tape, scheduler, isPolled } = withTape();
            expect(isPolled()).toBe(false);
            acia.setMotor(true);
            expect(tape.poll).toHaveBeenCalledTimes(1);
            scheduler.polltime(TapePollCycles - 1);
            expect(tape.poll).toHaveBeenCalledTimes(1);
            scheduler.polltime(1);
            expect(tape.poll).toHaveBeenCalledTimes(2);
        });

        it("stops polling a tape that has run out, and picks it up again once rewound", () => {
            const { acia, tape, isPolled } = withTape();
            tape.poll.mockReturnValueOnce(undefined);
            acia.setMotor(true);
            expect(acia.tapeRunning).toBe(false);
            expect(isPolled()).toBe(false);
            acia.rewindTape();
            expect(tape.rewind).toHaveBeenCalled();
            expect(acia.tapeRunning).toBe(true);
            expect(isPolled()).toBe(true);
        });

        it("does nothing when PLAY is pressed with the relay off", () => {
            const { acia, isPolled } = withTape();
            acia.pressStop();
            acia.pressPlay();
            expect(acia.tapeRunning).toBe(false);
            expect(isPolled()).toBe(false);
        });
    });

    describe("receive overrun", () => {
        it("should raise one notice for a burst of overruns", () => {
            const { acia } = createAcia();
            const notices = [];
            acia.addEventListener("notice", (event) => notices.push(event.detail));

            acia.receive(0x41);
            expect(notices).toHaveLength(0);
            acia.receive(0x42);
            acia.receive(0x43);
            expect(notices).toHaveLength(1);
            expect(notices[0].quietKey).toBe("quietSerialOverrun");
            expect(acia.read(0) & 0x20).toBe(0x20);
        });
    });

    describe("peeking", () => {
        it("shows the received byte without clearing receive-full", () => {
            const { acia } = createAcia();
            acia.receive(0x41);
            expect(acia.peek(1)).toBe(0x41);
            expect(acia.peek(0)).toBe(acia.read(0));
            expect(acia.peek(0) & Rdrf).toBe(Rdrf);
            acia.read(1);
            expect(acia.peek(0) & Rdrf).toBe(0);
        });
    });

    describe("transmit timing", () => {
        const timeToEmpty = (cr, rate, model) => {
            const scheduler = new Scheduler();
            const { acia } = createScheduledAcia(scheduler, cr, rate, model);
            acia.write(1, 0x55);
            let cycles = 0;
            while (!(acia.read(0) & Tdre)) {
                scheduler.polltime(1);
                cycles++;
            }
            return cycles;
        };

        it.each([
            ["one byte time", EightBitsOneStopNoParity, BbcModel, ByteCyclesAt75Baud],
            // The Atom has no ACIA; it stands in as a machine with a different clock.
            [
                "the byte time in the machine's own cycles",
                EightBitsOneStopNoParity,
                findModel("Atom"),
                ByteCyclesAt75Baud / 2,
            ],
            // Eleven bits: start, seven data, parity, two stop.
            ["the word format's byte time", SevenBitsTwoStopEvenParity, BbcModel, 293333],
        ])("should empty the transmit register after %s", (_, cr, model, cycles) => {
            expect(timeToEmpty(cr, 75, model)).toBe(cycles);
        });

        it("should interrupt when the transmit register empties", () => {
            const scheduler = new Scheduler();
            const { cpu, acia } = createScheduledAcia(
                scheduler,
                EightBitsOneStopNoParity | TransmitInterruptEnable,
                75,
            );
            acia.write(1, 0x55);
            expect(cpu.interrupt).toBe(0);
            scheduler.polltime(ByteCyclesAt75Baud);
            expect(cpu.interrupt).toBe(0x04);
            expect(acia.read(0) & 0x80).toBe(0x80);

            acia.write(1, 0x55);
            expect(cpu.interrupt).toBe(0);
        });

        it("should not interrupt when the transmit interrupt is disabled", () => {
            const scheduler = new Scheduler();
            const { cpu, acia } = createScheduledAcia(scheduler, EightBitsOneStopNoParity, 75);
            acia.write(1, 0x55);
            scheduler.polltime(ByteCyclesAt75Baud);
            expect(cpu.interrupt).toBe(0);
        });
    });

    describe("snapshots", () => {
        const quiet = { mute: () => {}, tone: () => {} };
        const relayNoise = { motorOn: () => {}, motorOff: () => {} };

        it("round-trips an ACIA sending, receiving and running a tape with its carrier up", async () => {
            const scheduler = new Scheduler();
            const cpu = { interrupt: 0, model: BbcModel };
            await expectSnapshotRoundTrips(
                () => new Acia(cpu, quiet, scheduler, relayNoise),
                (driven) => {
                    driven.write(0, ReceiveInterruptEnable | EightBitsOneStopNoParity | 1);
                    driven.setSerialReceive(9600);
                    driven.setSerialTransmit(1200);
                    scheduler.polltime(1000);
                    driven.write(1, 0x42);
                    driven.receive(0x5a);
                    driven.setTape({ poll: () => 100 });
                    driven.setMotor(true);
                    for (let i = 0; i < CarrierPollsToRaiseDcd; ++i) driven.setTapeCarrier(true);
                    driven.selectRs423(true);
                },
            );
        });

        it("keeps the recorder's PLAY latch, and restores an older snapshot with PLAY down", () => {
            const scheduler = new Scheduler();
            const source = new Acia({ interrupt: 0, model: BbcModel }, quiet, scheduler);
            source.pressStop();
            const snapshot = source.snapshotState();
            const tapeRunsAfterRestoring = (state) => {
                const restored = new Acia({ interrupt: 0, model: BbcModel }, quiet, scheduler, relayNoise);
                restored.restoreState(state);
                const tape = { poll: vi.fn(() => 100) };
                restored.setTape(tape);
                restored.setMotor(true);
                return tape.poll.mock.calls.length > 0;
            };
            expect(tapeRunsAfterRestoring(snapshot)).toBe(false);
            expect(tapeRunsAfterRestoring({ ...snapshot, playPressed: undefined })).toBe(true);
        });

        it("transmits at the restored rate", () => {
            const scheduler = new Scheduler();
            const { acia } = createScheduledAcia(scheduler, EightBitsOneStopNoParity, 75);
            const restored = new Acia({ interrupt: 0, model: BbcModel }, quiet, scheduler);
            restored.restoreState(acia.snapshotState());
            restored.write(1, 0x55);
            scheduler.polltime(ByteCyclesAt75Baud - 1);
            expect(restored.read(0) & Tdre).toBe(0);
            scheduler.polltime(1);
            expect(restored.read(0) & Tdre).toBe(Tdre);
        });

        it("polls RS423 at the restored receive rate", () => {
            const scheduler = new Scheduler();
            const { acia } = createScheduledAcia(scheduler, EightBitsOneStopNoParity, 75);
            acia.setSerialReceive(75);
            const restored = new Acia({ interrupt: 0, model: BbcModel }, quiet, scheduler);
            restored.restoreState(acia.snapshotState());
            const polledAt = [];
            restored.setRs423Handler({
                onTransmit: () => {},
                tryReceive: () => {
                    polledAt.push(scheduler.epoch);
                    return -1;
                },
            });
            restored.selectRs423(true);
            scheduler.polltime(2 * ByteCyclesAt75Baud);
            expect(polledAt[1] - polledAt[0]).toBe(ByteCyclesAt75Baud);
        });

        it("reasserts the IRQ it was holding", () => {
            const scheduler = new Scheduler();
            const { cpu, acia } = createScheduledAcia(scheduler, ReceiveInterruptEnable | EightBitsOneStopNoParity, 75);
            acia.receive(0x41);
            expect(cpu.interrupt).toBe(AciaIrq);
            const restoredCpu = { interrupt: 0, model: BbcModel };
            new Acia(restoredCpu, quiet, scheduler).restoreState(acia.snapshotState());
            expect(restoredCpu.interrupt).toBe(AciaIrq);
        });
    });
});

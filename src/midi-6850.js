const TransmitDataRegisterEmpty = 0x02;
const Irq = 0x40;
const MidiFrameBits = 10;
const MidiBaudRate = 31250;

export class Midi6850 {
    constructor(cpu, scheduler, cyclesPerSecond, midiOutput, interrupt, nmiSource) {
        this.cpu = cpu;
        this.scheduler = scheduler;
        this.midiOutput = midiOutput;
        this.interrupt = interrupt;
        this.nmiSource = nmiSource;
        this.transmitCompleteTask = scheduler.newTask(() => {
            this.status |= TransmitDataRegisterEmpty;
            this.updateInterrupt();
        });
        this.cyclesPerMidiByte = Math.floor((cyclesPerSecond * MidiFrameBits) / MidiBaudRate);
        this.reset();
    }

    reset() {
        this.control = 0;
        this.status = TransmitDataRegisterEmpty;
        this.data = 0;
        this.transmitCompleteTask.cancel();
        this.updateInterrupt();
    }

    read(addr) {
        return this.peek(addr);
    }

    peek(addr) {
        if (addr & 1) return this.data;
        return this.status | (this.transmitIrq() ? 0x80 : 0);
    }

    write(addr, value) {
        value &= 0xff;
        if (!(addr & 1)) {
            if ((value & 0x03) === 0x03) this.reset();
            else {
                this.control = value;
                this.updateInterrupt();
            }
            return;
        }

        this.data = value;
        this.status &= ~TransmitDataRegisterEmpty;
        this.transmitCompleteTask.reschedule(this.cyclesPerMidiByte);
        this.updateInterrupt();
        if (!this.cpu.replaying) this.midiOutput?.sendByte(value, this.scheduler.epoch);
    }

    transmitIrq() {
        return (this.control & 0x60) === 0x20 && !!(this.status & TransmitDataRegisterEmpty);
    }

    updateInterrupt() {
        const asserted = this.transmitIrq();
        if (this.interrupt === "irq" && asserted) this.cpu.interrupt |= Irq;
        else this.cpu.interrupt &= ~Irq;
        this.cpu.setNmi(this.nmiSource, this.interrupt === "nmi" && asserted);
    }

    snapshotState() {
        return {
            control: this.control,
            status: this.status,
            data: this.data,
            transmitCompleteTaskOffset: this.transmitCompleteTask.offset(),
        };
    }

    restoreState(state) {
        this.control = state.control;
        this.status = state.status;
        this.data = state.data;
        this.updateInterrupt();
        this.transmitCompleteTask.restoreOffset(state.transmitCompleteTaskOffset);
    }
}

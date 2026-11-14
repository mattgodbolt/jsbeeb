const TransmitDataRegisterEmpty = 0x02;
const MidiFrameBits = 10;
const MidiBaudRate = 31250;

export class Midi6850 {
    constructor(cpu, scheduler, cyclesPerSecond, midiOutput) {
        this.cpu = cpu;
        this.midiOutput = midiOutput;
        this.transmitCompleteTask = scheduler.newTask(() => {
            this.status |= TransmitDataRegisterEmpty;
            this.updateIrq();
        });
        this.cyclesPerMidiByte = Math.floor((cyclesPerSecond * MidiFrameBits) / MidiBaudRate);
        this.reset();
    }

    reset() {
        this.control = 0;
        this.status = TransmitDataRegisterEmpty;
        this.data = 0;
        this.transmitCompleteTask.cancel();
        this.updateIrq();
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
                this.updateIrq();
            }
            return;
        }

        this.data = value;
        this.status &= ~TransmitDataRegisterEmpty;
        this.transmitCompleteTask.reschedule(this.cyclesPerMidiByte);
        this.updateIrq();
        this.midiOutput?.sendByte(value);
    }

    transmitIrq() {
        return (this.control & 0x60) === 0x20 && !!(this.status & TransmitDataRegisterEmpty);
    }

    updateIrq() {
        if (this.transmitIrq()) this.cpu.interrupt |= 0x08;
        else this.cpu.interrupt &= ~0x08;
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
        this.updateIrq();
        this.transmitCompleteTask.restoreOffset(state.transmitCompleteTaskOffset);
    }
}

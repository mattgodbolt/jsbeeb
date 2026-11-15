import { Fifo } from "./binary.js";

// The 501's manual gives no rate, only "a constant stream" at 9600 baud. Soundspace parses at most about 44 reports
// a second; feeding it faster queues stale positions, so this stays well under that.
const PollHz = 25;

// The Touchtech 501 reports 0-120 across and 0-90 up the screen. The edges are those ranges' ends on the canvas,
// as fractions of it, fitted to where Soundspace's shipped calibration expects its 40 by 25 screen to be.
const UnitsAcross = 120;
const UnitsUp = 90;
const GridLeft = 0.112;
const GridRight = 0.853;
const GridTop = 0.113;
const GridBottom = 0.946;

const NotTouched = 0xff;
const NibbleByte = 0x40;
const EndOfReport = ".".charCodeAt(0);
const ContinuousModeFlag = 0x80;
const PointMode = 1;
const SizeMode = 2;
const MultipleMode = 3;
const MultipleModePoints = 4;
const OutBufferSize = 64;

function toTouchUnits(val, from, to, units) {
    const scaled = ((val - from) / (to - from)) * units;
    return Math.min(units, Math.max(0, scaled)) | 0;
}

function hasReport(mode) {
    const request = mode & ~ContinuousModeFlag;
    return request === PointMode || request === SizeMode || request === MultipleMode;
}

/**
 * The values a report in `mode` carries, each sent as two nibbles, or null for a mode with no report. Multiple mode
 * sends four X then four Y; one pointer fills the first of each.
 */
function reportValues(mode, x, y) {
    switch (mode & ~ContinuousModeFlag) {
        case PointMode:
        case SizeMode:
            return [x, y];
        case MultipleMode: {
            const unused = new Array(MultipleModePoints - 1).fill(NotTouched);
            return [x, ...unused, y, ...unused];
        }
        default:
            return null;
    }
}

export class TouchScreen {
    constructor(scheduler, cyclesPerSecond) {
        this.scheduler = scheduler;
        this.pollCycles = cyclesPerSecond / PollHz;
        this.outBuffer = new Fifo(OutBufferSize);
        this.pollTask = this.scheduler.newTask(() => this.poll());
        /** @type {import("./replay.js").InputLog | null} */
        this.inputLog = null;
        this.reset();
    }

    reset() {
        this.mouse = { x: 0, y: 0, button: 0 };
        // The latest press since the last report, so a click or tap shorter than a poll still reaches the guest.
        this.unreportedPress = null;
        this.mode = 0;
        this.outBuffer.clear();
        this.pollTask.cancel();
    }

    snapshotState() {
        return {
            mode: this.mode,
            outBuffer: this.outBuffer.toArray(),
            pollTaskOffset: this.pollTask.offset(),
        };
    }

    restoreState(state) {
        this.mode = state.mode;
        this.outBuffer.clear();
        for (const byte of state.outBuffer) this.outBuffer.put(byte);
        this.pollTask.restoreOffset(state.pollTaskOffset);
        this.unreportedPress = null;
    }

    tryReceive(rts) {
        if (this.outBuffer.size && rts) return this.outBuffer.get();
        return -1;
    }

    doRead() {
        const touch = this.mouse.button ? this.mouse : (this.unreportedPress ?? this.mouse);
        const { x, y, button } = this.inputLog ? this.inputLog.sample("touch", touch) : touch;
        const values = reportValues(
            this.mode,
            button ? toTouchUnits(x, GridLeft, GridRight, UnitsAcross) : NotTouched,
            button ? toTouchUnits(y, GridBottom, GridTop, UnitsUp) : NotTouched,
        );
        if (!values) {
            this.unreportedPress = null;
            return;
        }
        const report = values.flatMap((value) => [NibbleByte | (value >>> 4), NibbleByte | (value & 0x0f)]);
        report.push(EndOfReport);
        // While the guest holds RTS off, a report that would not fit whole is dropped rather than sent cut short.
        if (this.outBuffer.size + report.length > OutBufferSize) return;
        for (const byte of report) this.outBuffer.put(byte);
        this.unreportedPress = null;
    }

    poll() {
        this.doRead();
        this.pollTask.reschedule(this.pollCycles);
    }

    onMouse(x, y, button) {
        this.mouse = { x: x, y: y, button: button };
        if (button) this.unreportedPress = this.mouse;
    }

    onTransmit(val) {
        switch (String.fromCharCode(val)) {
            case "M":
                this.mode = 0;
                this.unreportedPress = null;
                break;
            case "0":
            case "1":
            case "2":
            case "3":
            case "4":
            case "5":
            case "6":
            case "7":
            case "8":
            case "9":
                this.mode = 10 * this.mode + val - "0".charCodeAt(0);
                break;
            case ".":
                break;
            case "?":
                if (!(this.mode & ContinuousModeFlag)) this.doRead();
                break;
        }
        this.pollTask.ensureScheduled(!!(this.mode & ContinuousModeFlag) && hasReport(this.mode), this.pollCycles);
    }
}

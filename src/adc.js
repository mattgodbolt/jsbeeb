/**
 * BBC Micro Analogue to Digital Converter (ADC)
 * Handles input from analogue sources through various channels
 *
 * @typedef {import('./analogue-source.js').AnalogueSource} AnalogueSource
 */
export const AdcCentreValue = 0x8000;
// The uPD7002 converts to 12 bits; the AUG gives bits 3-0 of the low byte as always zero.
const LowByteResultBits = 0xf0;

export class Adc {
    /**
     * Create a new ADC
     * @param {object} sysvia - System VIA interface
     * @param {object} scheduler - Scheduler for timing operations
     */
    constructor(sysvia, scheduler) {
        this.sysvia = sysvia;
        this.task = scheduler.newTask(this.onComplete.bind(this));
        this.status = 0x40;
        this.low = 0x00;
        this.high = 0x00;

        // Initialize channel sources (one source per channel)
        this.channelSources = [null, null, null, null];
        this.fixedValue = null;
    }

    /**
     * Makes every channel read `value` whatever its source, or read its source again
     * with null.
     * @param {number|null} value
     */
    setFixedValue(value) {
        this.fixedValue = value;
    }

    /**
     * Reset the ADC state
     */
    reset() {
        this.status = 0x40;
        this.low = 0x00;
        this.high = 0x00;
    }

    /**
     * Set the source for a specific channel, disposing of the one it replaces.
     * @param {number} channel - The channel number (0-3)
     * @param {AnalogueSource} source - The source to assign to the channel
     */
    setChannelSource(channel, source) {
        const oldSource = this.channelSources[channel];
        if (oldSource && oldSource !== source) oldSource.dispose();
        this.channelSources[channel] = source;
    }

    snapshotState() {
        const scheduler = this.task.scheduler;
        return {
            status: this.status,
            low: this.low,
            high: this.high,
            taskOffset: this.task.scheduled() ? this.task.expireEpoch - scheduler.epoch : null,
        };
    }

    restoreState(state) {
        this.status = state.status;
        this.low = state.low;
        this.high = state.high;
        this.task.cancel();
        if (state.taskOffset !== null) {
            this.task.schedule(state.taskOffset);
            // Conversion in progress: CB1 should be high (set by write(), cleared by onComplete())
            this.sysvia.setcb1(true);
        }
    }

    /**
     * Read from the ADC registers
     * @param {number} addr - The address to read from
     * @returns {number} The value at the address
     */
    read(addr) {
        return this.peek(addr);
    }

    /**
     * Read from the ADC registers without side effects; reading the ADC has none, so read() is this
     * @param {number} addr - The address to read from
     * @returns {number} The value at the address
     */
    peek(addr) {
        switch (addr & 3) {
            case 0:
                return this.status;
            case 1:
                return this.high;
            case 2:
                return this.low;
            default:
                break;
        }
        return 0x40;
    }

    /**
     * Write to the ADC control register
     * @param {number} addr - The address to write to
     * @param {number} val - The value to write
     */
    write(addr, val) {
        if ((addr & 3) !== 0) return;
        // 8 bit conversion takes 4ms whereas 10 bit conversions take 10ms, according to AUG
        this.task.cancel();
        this.task.schedule(val & 0x08 ? 20000 : 8000);
        this.status = (val & 0x0f) | 0x80;
        this.sysvia.setcb1(true);
    }

    /**
     * Called when the ADC conversion is complete
     */
    onComplete() {
        const channel = this.status & 0x03;

        const source = this.channelSources[channel];
        const val = this.fixedValue ?? (source ? source.getValue(channel) : AdcCentreValue);

        // The AUG puts the result's top two bits in status bits 5 and 4.
        this.status = (this.status & 0x0f) | 0x40 | ((val >>> 10) & 0x30);
        this.low = val & LowByteResultBits;
        this.high = (val >>> 8) & 0xff;
        this.sysvia.setcb1(false);
    }
}

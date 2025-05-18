/**
 * BBC Micro Analogue to Digital Converter (ADC)
 * Handles input from analogue sources through various channels
 */
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
        this.sources = [];
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
     * Add an analogue source to the ADC
     * @param {object} source - The analogue source to add
     * @returns {boolean} True if the source was added successfully
     */
    addSource(source) {
        this.sources.push(source);
        return true;
    }

    /**
     * Remove an analogue source from the ADC
     * @param {object} source - The analogue source to remove
     * @returns {boolean} True if the source was found and removed
     */
    removeSource(source) {
        const index = this.sources.indexOf(source);
        if (index !== -1) {
            const removedSource = this.sources.splice(index, 1)[0];
            removedSource.dispose();
            return true;
        }
        return false;
    }

    /**
     * Clear all sources
     */
    clearSources() {
        for (const source of this.sources) {
            source.dispose();
        }
        this.sources = [];
    }

    /**
     * Read from the ADC registers
     * @param {number} addr - The address to read from
     * @returns {number} The value at the address
     */
    read(addr) {
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
        let val = 0x8000; // Default center value

        // Try each source in order until one provides a value for this channel
        for (const source of this.sources) {
            if (source.hasChannel(channel)) {
                val = source.getValue(channel);
                break;
            }
        }

        this.status = (this.status & 0x0f) | 0x40 | ((val >>> 10) & 0x03);
        this.low = val & 0xff;
        this.high = (val >>> 8) & 0xff;
        this.sysvia.setcb1(false);
    }
}

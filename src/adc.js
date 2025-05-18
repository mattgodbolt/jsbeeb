/**
 * BBC Micro Analogue to Digital Converter (ADC)
 * Handles input from analogue sources through various channels
 *
 * @typedef {import('./analogue-source.js').AnalogueSource} AnalogueSource
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

        // Initialize channel sources (one source per channel)
        this.channelSources = [null, null, null, null];
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
     * Set the source for a specific channel
     * @param {number} channel - The channel number (0-3)
     * @param {AnalogueSource} source - The source to assign to the channel
     * @returns {boolean} True if the assignment was successful
     */
    setChannelSource(channel, source) {
        if (channel < 0 || channel > 3) {
            console.error(`ADC: Invalid channel number: ${channel}`);
            return false;
        }

        // Dispose of the old source if one exists and is different
        const oldSource = this.channelSources[channel];
        if (oldSource && oldSource !== source) {
            oldSource.dispose();
        }

        // Set the channel source
        this.channelSources[channel] = source;
        return true;
    }

    /**
     * Get the source for a specific channel
     * @param {number} channel - The channel number (0-3)
     * @returns {AnalogueSource|null} The source for the channel or null if none
     */
    getChannelSource(channel) {
        if (channel < 0 || channel > 3) {
            return null;
        }
        return this.channelSources[channel];
    }

    /**
     * Clear the source for a specific channel
     * @param {number} channel - The channel number (0-3)
     * @returns {boolean} True if successful
     */
    clearChannelSource(channel) {
        if (channel < 0 || channel > 3) {
            console.error(`ADC: Invalid channel number: ${channel}`);
            return false;
        }

        const source = this.channelSources[channel];
        if (source) {
            source.dispose();
            this.channelSources[channel] = null;
        }

        return true;
    }

    /**
     * Clear all sources
     */
    clearSources() {
        // Dispose and clear all channel sources
        for (let i = 0; i < 4; i++) {
            const source = this.channelSources[i];
            if (source) {
                source.dispose();
                this.channelSources[i] = null;
            }
        }
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

        const source = this.channelSources[channel];
        const val = source ? source.getValue(channel) : 0x8000;

        this.status = (this.status & 0x0f) | 0x40 | ((val >>> 10) & 0x03);
        this.low = val & 0xff;
        this.high = (val >>> 8) & 0xff;
        this.sysvia.setcb1(false);
    }
}

/**
 * Base interface for analog input sources for the BBC Micro's ADC
 * @abstract
 */
export class AnalogueSource {
    /**
     * Get the current value for the specified channel
     * @param {number} channel - The ADC channel (0-3)
     * @returns {number} A value between 0 and 0xffff
     */
    getValue(_channel) {
        throw new Error("Method not implemented");
    }

    /**
     * Clean up resources when source is no longer needed
     */
    dispose() {
        // Optional cleanup method
    }
}

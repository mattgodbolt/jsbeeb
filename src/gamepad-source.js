import { AnalogueSource } from "./analogue-source.js";

/**
 * Gamepad implementation of AnalogueSource
 * Maps gamepad axes to ADC channels
 */
export class GamepadSource extends AnalogueSource {
    /**
     * Create a new GamepadSource
     * @param {Function} getGamepads - Function that returns gamepad array
     */
    constructor(getGamepads) {
        super();
        this.getGamepads = getGamepads;
    }

    /**
     * Get analog value from gamepad for the specified channel
     * @param {number} channel - The ADC channel (0-3)
     * @returns {number} A value between 0 and 0xffff
     */
    getValue(channel) {
        const pads = this.getGamepads();
        if (!pads || !pads[0]) return 0x8000; // Default center value

        const pad = pads[0];
        const pad2 = pads[1];

        let rawValue = 0;

        switch (channel) {
            case 0:
                rawValue = pad.axes[0];
                break;
            case 1:
                rawValue = pad.axes[1];
                break;
            case 2:
                if (pad2) {
                    rawValue = pad2.axes[0];
                } else {
                    rawValue = pad.axes[2];
                }
                break;
            case 3:
                if (pad2) {
                    rawValue = pad2.axes[1];
                } else {
                    rawValue = pad.axes[3];
                }
                break;
            default:
                return 0x8000;
        }

        // Scale from [-1, 1] to [0, 0xffff]
        return Math.floor(((1 - rawValue) / 2) * 0xffff);
    }

    /**
     * Check if this source provides input for the specified channel
     * @param {number} channel - The ADC channel (0-3)
     * @returns {boolean} True if this source provides input for the channel
     */
    hasChannel(channel) {
        // First check if we're valid channel in range
        if (channel < 0 || channel > 3) {
            console.log(`GamepadSource: hasChannel(${channel}), false - out of range`);
            return false;
        }

        // Then check if the channel is blocked
        if (this.blockedChannels && this.blockedChannels.includes(channel)) {
            console.log(`GamepadSource: hasChannel(${channel}), false - blocked channel`);
            return false;
        }

        console.log(`GamepadSource: hasChannel(${channel}), true - channel is available`);
        return true;
    }

    /**
     * Set blocked channels - channels that this source should not handle
     * Used when another input source takes priority
     * @param {number[]} channels - Array of channel numbers to block
     */
    setBlockedChannels(channels) {
        this.blockedChannels = channels;
        console.log(`GamepadSource: Blocking channels:`, channels);
    }
}

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
}

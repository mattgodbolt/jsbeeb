import { AnalogueSource } from "./analogue-source.js";

/**
 * An AnalogueSource that maps accessibility switch keys to ADC channels.
 *
 * When switch N is pressed, channel N returns 0x0000 (full deflection).
 * When not pressed, the call is delegated to the wrapped fallback source
 * (typically the gamepad source).
 *
 * Switches 0 and 1 additionally map to the joystick fire buttons (PB4/PB5
 * on the System VIA), so ADVAL(-1) / ADVAL(-2) reflect switch state too.
 */
export class KeyboardSwitchSource extends AnalogueSource {
    /**
     * @param {AnalogueSource} fallback - Source to delegate to when no switch is pressed
     */
    constructor(fallback) {
        super();
        this.fallback = fallback;
        this._switchValues = new Array(4).fill(null); // null = not pressed
    }

    /**
     * Activate or deactivate a switch.
     * @param {number} n - Switch index (0-3)
     * @param {boolean} pressed
     */
    setSwitch(n, pressed) {
        if (n >= 0 && n < 4) {
            this._switchValues[n] = pressed ? 0x0000 : null;
        }
    }

    /** @override */
    getValue(channel) {
        if (channel >= 0 && channel < 4 && this._switchValues[channel] !== null) {
            return this._switchValues[channel];
        }
        return this.fallback ? this.fallback.getValue(channel) : 0x8000;
    }
}

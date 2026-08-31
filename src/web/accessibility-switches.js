/**
 * The accessibility switches on the user port. Bits 0-7 correspond to switches
 * 1-8, active low: 0xff = no switches pressed; a clear bit = that switch held.
 *
 * On real hardware, the Brilliant Computing switch interface box and special-ed
 * joystick connect to the User Port only; they do not touch the analogue port
 * or the System VIA fire buttons (PB4/PB5), which belong to the standard
 * analogue joystick connector.
 */
export class AccessibilitySwitches {
    constructor() {
        this.switchState = 0xff;
        const switches = this;
        this.userPort = {
            write() {},
            read() {
                return switches.switchState;
            },
        };
    }

    setSwitch(index, held) {
        if (held) this.switchState &= ~(1 << index);
        else this.switchState |= 1 << index;
    }
}

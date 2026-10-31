export class GamePad {
    /**
     * @param {object} model - the emulated machine, whose keys the controls press
     */
    constructor(model) {
        this.gamepad0 = null;
        this.keys = model.keys;
        this.gamepadMapping = Object.assign([], model.gamepadKeys);

        // Gamepad joysticks
        this.gamepadAxisMapping = [[], [], [], []];
    }

    /**
     * Maps a gamepad button or stick direction to a key on the emulated machine.
     * @param {string} gamepadKey - the gamepad control, eg `FIRE2`
     * @param {string} machineKey - the key to press, eg `RETURN`
     * @returns {?string} a description of the problem, or null if the mapping was applied
     */
    remap(gamepadKey, machineKey) {
        // convert "1" into "K1"
        if (machineKey.length === 1 && machineKey >= "0" && machineKey <= "9") {
            machineKey = "K" + machineKey;
        }

        const mappedKey = this.keys[machineKey];
        if (!mappedKey) {
            return `"${machineKey}" is not a key on the emulated machine.`;
        }

        switch (gamepadKey) {
            case "LEFT":
                this.gamepadMapping[3] = mappedKey;
                this.gamepadAxisMapping[0][-1] = mappedKey;
                this.gamepadAxisMapping[2][-1] = mappedKey;
                break;
            case "RIGHT":
                this.gamepadMapping[1] = mappedKey;
                this.gamepadAxisMapping[0][1] = mappedKey;
                this.gamepadAxisMapping[2][1] = mappedKey;
                break;
            case "UP":
                this.gamepadMapping[0] = mappedKey;
                this.gamepadAxisMapping[1][-1] = mappedKey;
                this.gamepadAxisMapping[3][-1] = mappedKey;
                break;
            case "DOWN":
                this.gamepadMapping[2] = mappedKey;
                this.gamepadAxisMapping[1][1] = mappedKey;
                this.gamepadAxisMapping[3][1] = mappedKey;
                break;
            case "FIRE":
                for (let i = 0; i < 16; i++) {
                    this.gamepadMapping[i] = mappedKey;
                }
                break;

            // XBox 360 Controller names
            case "UP2":
                this.gamepadAxisMapping[3][-1] = mappedKey;
                break;
            case "UP1":
                this.gamepadAxisMapping[1][-1] = mappedKey;
                break;
            case "UP3":
                this.gamepadMapping[0] = mappedKey;
                break;
            case "DOWN2":
                this.gamepadAxisMapping[3][1] = mappedKey;
                break;
            case "DOWN1":
                this.gamepadAxisMapping[1][1] = mappedKey;
                break;
            case "DOWN3":
                this.gamepadMapping[2] = mappedKey;
                break;
            case "LEFT2":
                this.gamepadAxisMapping[2][-1] = mappedKey;
                break;
            case "LEFT1":
                this.gamepadAxisMapping[0][-1] = mappedKey;
                break;
            case "LEFT3":
                this.gamepadMapping[3] = mappedKey;
                break;
            case "RIGHT2":
                this.gamepadAxisMapping[2][1] = mappedKey;
                break;
            case "RIGHT1":
                this.gamepadAxisMapping[0][1] = mappedKey;
                break;
            case "RIGHT3":
                this.gamepadMapping[1] = mappedKey;
                break;
            case "FIRE2":
                this.gamepadMapping[11] = mappedKey;
                break;
            case "FIRE1":
                this.gamepadMapping[10] = mappedKey;
                break;
            case "A":
                this.gamepadMapping[0] = mappedKey;
                break;
            case "B":
                this.gamepadMapping[1] = mappedKey;
                break;
            case "X":
                this.gamepadMapping[2] = mappedKey;
                break;
            case "Y":
                this.gamepadMapping[3] = mappedKey;
                break;
            case "START":
                this.gamepadMapping[9] = mappedKey;
                break;
            case "BACK":
                this.gamepadMapping[8] = mappedKey;
                break;
            case "RB":
                this.gamepadMapping[5] = mappedKey;
                break;
            case "RT":
                this.gamepadMapping[7] = mappedKey;
                break;
            case "LB":
                this.gamepadMapping[4] = mappedKey;
                break;
            case "LT":
                this.gamepadMapping[6] = mappedKey;
                break;
            default:
                return `unknown gamepad control "${gamepadKey}".`;
        }

        return null;
    }

    /**
     * Reads the pads, once a frame: presses the keys mapped to their controls and latches the FIRE buttons.
     * @param {object} processor - the emulated machine
     */
    update(processor) {
        const keyboard = processor.keyboardInterface;
        const pads = processor.config.getGamepads();
        const pad = pads[0];
        // FIRE1 on a second pad is the second fire button.
        processor.sysvia.setGamepadFire(
            !!pad?.buttons[10]?.pressed,
            !!pad && (!!pad.buttons[11]?.pressed || !!pads[1]?.buttons[10]?.pressed),
        );
        if (pad && !this.gamepad0) {
            this.gamepadButtons = new Array(16).fill(false);
            this.gamepadAxes = [0, 0, 0, 0];
        }
        this.gamepad0 = pad;

        if (this.gamepad0) {
            for (let i = 0; i < 4; i++) {
                const axisRaw = this.gamepad0.axes[i];

                // Mike's XBox 360 controller, zero positions
                // console.log(i, axisRaw, axis);
                //0 -0.03456169366836548 -1
                //1 -0.037033677101135254 -1
                //2 0.055374979972839355 1
                //3 0.06575113534927368 1
                const threshold = 0.15;

                // normalize to -1, 0, 1
                let axis;
                if (axisRaw < -threshold) {
                    axis = -1;
                } else if (axisRaw > threshold) {
                    axis = 1;
                } else {
                    axis = 0;
                }

                if (axis !== this.gamepadAxes[i]) {
                    // tricky because transition can be
                    // -1 to 0
                    // -1 to 1
                    // 0 to 1
                    // 0 to -1
                    // 1 to 0
                    // 1 to -1
                    const oldKey = this.gamepadAxisMapping[i][this.gamepadAxes[i]];
                    if (oldKey) {
                        keyboard.keyUpRaw(oldKey);
                    }

                    const newKey = this.gamepadAxisMapping[i][axis];
                    if (newKey) {
                        keyboard.keyDownRaw(newKey);
                    }
                }

                // store new state
                this.gamepadAxes[i] = axis;
            }

            for (let i = 0; i < 16; i++) {
                if (this.gamepad0.buttons[i]) {
                    const button = this.gamepad0.buttons[i];

                    if (button.pressed !== this.gamepadButtons[i]) {
                        // different to last time

                        if (this.gamepadMapping[i]) {
                            if (button.pressed) {
                                keyboard.keyDownRaw(this.gamepadMapping[i]);
                            } else {
                                keyboard.keyUpRaw(this.gamepadMapping[i]);
                            }
                        }
                    }

                    // store new state
                    this.gamepadButtons[i] = button.pressed;
                }
            }
        }
    }
}

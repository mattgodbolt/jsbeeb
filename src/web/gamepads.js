/** Each stick direction as [axis, direction], in the browser's standard mapping. */
const LeftStick = { up: [1, -1], down: [1, 1], left: [0, -1], right: [0, 1] };
const RightStick = { up: [3, -1], down: [3, 1], left: [2, -1], right: [2, 1] };

/**
 * The buttons, by their index in the browser's standard mapping, and the stick directions each `GP.` control name
 * sets. A direction takes the D-pad and both sticks; `FIRE` takes every button that is neither a direction nor Start.
 */
const Controls = {
    A: { buttons: [0], axes: [] },
    B: { buttons: [1], axes: [] },
    X: { buttons: [2], axes: [] },
    Y: { buttons: [3], axes: [] },
    LB: { buttons: [4], axes: [] },
    RB: { buttons: [5], axes: [] },
    LT: { buttons: [6], axes: [] },
    RT: { buttons: [7], axes: [] },
    BACK: { buttons: [8], axes: [] },
    START: { buttons: [9], axes: [] },
    FIRE1: { buttons: [10], axes: [] },
    FIRE2: { buttons: [11], axes: [] },
    FIRE: { buttons: [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11], axes: [] },
    UP: { buttons: [12], axes: [LeftStick.up, RightStick.up] },
    DOWN: { buttons: [13], axes: [LeftStick.down, RightStick.down] },
    LEFT: { buttons: [14], axes: [LeftStick.left, RightStick.left] },
    RIGHT: { buttons: [15], axes: [LeftStick.right, RightStick.right] },
    UP1: { buttons: [], axes: [LeftStick.up] },
    DOWN1: { buttons: [], axes: [LeftStick.down] },
    LEFT1: { buttons: [], axes: [LeftStick.left] },
    RIGHT1: { buttons: [], axes: [LeftStick.right] },
    UP2: { buttons: [], axes: [RightStick.up] },
    DOWN2: { buttons: [], axes: [RightStick.down] },
    LEFT2: { buttons: [], axes: [RightStick.left] },
    RIGHT2: { buttons: [], axes: [RightStick.right] },
    UP3: { buttons: [0], axes: [] },
    DOWN3: { buttons: [2], axes: [] },
    LEFT3: { buttons: [3], axes: [] },
    RIGHT3: { buttons: [1], axes: [] },
};

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
        /** @type {Object<string, string>} the key names the URL gave each control, by the control's name */
        this.remapped = {};
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

        if (!Object.hasOwn(Controls, gamepadKey)) {
            return `unknown gamepad control "${gamepadKey}".`;
        }
        const { buttons, axes } = Controls[gamepadKey];
        for (const button of buttons) this.gamepadMapping[button] = mappedKey;
        for (const [axis, direction] of axes) this.gamepadAxisMapping[axis][direction] = mappedKey;

        this.remapped[gamepadKey] = machineKey;
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

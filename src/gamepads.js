"use strict";
import * as utils from "./utils.js";

const BBC = utils.BBC;

export class GamePad {
    constructor() {
        this.gamepad0 = null;

        //this.gamepadMapping = [BBC.COLON_STAR, BBC.X, BBC.SLASH, BBC.Z,
        //    BBC.SPACE, BBC.SPACE, BBC.SPACE, BBC.SPACE,
        //    BBC.SPACE, BBC.SPACE, BBC.SPACE, BBC.SPACE,
        //    BBC.SPACE, BBC.SPACE, BBC.SPACE, BBC.SPACE];

        this.gamepadMapping = [];

        // default: "snapper" keys
        this.gamepadMapping[14] = BBC.Z;
        this.gamepadMapping[15] = BBC.X;
        this.gamepadMapping[13] = BBC.SLASH;
        this.gamepadMapping[12] = BBC.COLON_STAR;

        // often <Return> = "Fire"
        this.gamepadMapping[0] = BBC.RETURN;
        // "start" (often <Space> to start game)
        this.gamepadMapping[9] = BBC.SPACE;

        // Gamepad joysticks
        this.gamepadAxisMapping = [[], [], [], []];
    }

    /*
         this.gamepadAxisMapping[0][-1] = BBC.Z;          // left
         this.gamepadAxisMapping[0][1] = BBC.X;          // right
         this.gamepadAxisMapping[1][-1] = BBC.COLON_STAR; // up
         this.gamepadAxisMapping[1][1] = BBC.SLASH;      // down
         this.gamepadAxisMapping[2][-1] = BBC.Z;          // left
         this.gamepadAxisMapping[2][1] = BBC.X;          // right
         this.gamepadAxisMapping[3][-1] = BBC.COLON_STAR; // up
         this.gamepadAxisMapping[3][1] = BBC.SLASH;      // down
         */
    remap(gamepadKey, bbcKey) {
        // convert "1" into "K1"
        if ("0123456789".indexOf(bbcKey) > 0) {
            bbcKey = "K" + bbcKey;
        }

        const mappedBbcKey = BBC[bbcKey];
        if (!mappedBbcKey) {
            console.log("unknown BBC key: " + bbcKey);
            return;
        }

        switch (gamepadKey) {
            case "LEFT":
                this.gamepadMapping[3] = mappedBbcKey;
                this.gamepadAxisMapping[0][-1] = mappedBbcKey;
                this.gamepadAxisMapping[2][-1] = mappedBbcKey;
                break;
            case "RIGHT":
                this.gamepadMapping[1] = mappedBbcKey;
                this.gamepadAxisMapping[0][1] = mappedBbcKey;
                this.gamepadAxisMapping[2][1] = mappedBbcKey;
                break;
            case "UP":
                this.gamepadMapping[0] = mappedBbcKey;
                this.gamepadAxisMapping[1][-1] = mappedBbcKey;
                this.gamepadAxisMapping[3][-1] = mappedBbcKey;
                break;
            case "DOWN":
                this.gamepadMapping[2] = mappedBbcKey;
                this.gamepadAxisMapping[1][1] = mappedBbcKey;
                this.gamepadAxisMapping[3][1] = mappedBbcKey;
                break;
            case "FIRE":
                for (let i = 0; i < 16; i++) {
                    this.gamepadMapping[i] = mappedBbcKey;
                }
                break;

            // XBox 360 Controller names
            case "UP2":
                this.gamepadAxisMapping[3][-1] = mappedBbcKey;
                break;
            case "UP1":
                this.gamepadAxisMapping[1][-1] = mappedBbcKey;
                break;
            case "UP3":
                this.gamepadMapping[0] = mappedBbcKey;
                break;
            case "DOWN2":
                this.gamepadAxisMapping[3][1] = mappedBbcKey;
                break;
            case "DOWN1":
                this.gamepadAxisMapping[1][1] = mappedBbcKey;
                break;
            case "DOWN3":
                this.gamepadMapping[2] = mappedBbcKey;
                break;
            case "LEFT2":
                this.gamepadAxisMapping[2][-1] = mappedBbcKey;
                break;
            case "LEFT1":
                this.gamepadAxisMapping[0][-1] = mappedBbcKey;
                break;
            case "LEFT3":
                this.gamepadMapping[3] = mappedBbcKey;
                break;
            case "RIGHT2":
                this.gamepadAxisMapping[2][1] = mappedBbcKey;
                break;
            case "RIGHT1":
                this.gamepadAxisMapping[0][1] = mappedBbcKey;
                break;
            case "RIGHT3":
                this.gamepadMapping[1] = mappedBbcKey;
                break;
            case "FIRE2":
                this.gamepadMapping[11] = mappedBbcKey;
                break;
            case "FIRE1":
                this.gamepadMapping[10] = mappedBbcKey;
                break;
            case "A":
                this.gamepadMapping[0] = mappedBbcKey;
                break;
            case "B":
                this.gamepadMapping[1] = mappedBbcKey;
                break;
            case "X":
                this.gamepadMapping[2] = mappedBbcKey;
                break;
            case "Y":
                this.gamepadMapping[3] = mappedBbcKey;
                break;
            case "START":
                this.gamepadMapping[9] = mappedBbcKey;
                break;
            case "BACK":
                this.gamepadMapping[8] = mappedBbcKey;
                break;
            case "RB":
                this.gamepadMapping[5] = mappedBbcKey;
                break;
            case "RT":
                this.gamepadMapping[7] = mappedBbcKey;
                break;
            case "LB":
                this.gamepadMapping[4] = mappedBbcKey;
                break;
            case "LT":
                this.gamepadMapping[6] = mappedBbcKey;
                break;
            default:
                console.log("unknown gamepad key: " + gamepadKey);
        }
    }

    update(sysvia) {
        // init gamepad
        // gamepad not necessarily available until a button press
        // so need to check gamepads[0] continuously
        if (navigator.getGamepads && !this.gamepad0) {
            const gamepads = navigator.getGamepads();
            this.gamepad0 = gamepads[0];

            if (this.gamepad0) {
                console.log("initing gamepad");
                // 16 buttons
                this.gamepadButtons = [
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                    false,
                ];

                // two joysticks (so 4 axes)
                this.gamepadAxes = [0, 0, 0, 0];
            }
        }

        // process gamepad buttons
        if (this.gamepad0) {
            // these two lines needed in Chrome to update state, not Firefox
            // TODO: what about IE? (can't get Gamepads to work in IE11/IE12. Mike)
            if (!utils.isFirefox()) {
                this.gamepad0 = navigator.getGamepads()[0];
            }

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
                        sysvia.keyUpRaw(oldKey);
                    }

                    const newKey = this.gamepadAxisMapping[i][axis];
                    if (newKey) {
                        sysvia.keyDownRaw(newKey);
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
                                sysvia.keyDownRaw(this.gamepadMapping[i]);
                            } else {
                                sysvia.keyUpRaw(this.gamepadMapping[i]);
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

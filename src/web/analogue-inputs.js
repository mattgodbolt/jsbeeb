import { GamepadSource } from "../gamepad-source.js";
import { MicrophoneInput } from "../microphone-input.js";
import { MouseJoystickSource } from "../mouse-joystick-source.js";
import { calculateMouseCoordinates } from "../mouse-coordinates.js";
import { toast } from "./toast.js";

const AdcChannelCount = 4;

/**
 * What feeds the analogue port and the touchscreen: the gamepad, the mouse
 * acting as a joystick, and the microphone, with the mouse on the monitor
 * routed to whichever of them wants it.
 */
export class AnalogueInputs {
    constructor({ processor, screenCanvas, getGamepads, urlState, config, audioHandler }) {
        this.processor = processor;
        this.urlState = urlState;
        this.config = config;

        this.gamepadSource = new GamepadSource(getGamepads);
        // Create MicrophoneInput but don't enable by default
        this.microphoneInput = new MicrophoneInput();
        this.microphoneInput.setErrorCallback((message) => {
            toast(`${message} The microphone channel has been turned off.`, { title: "Microphone" });
        });

        // Create MouseJoystickSource but don't enable by default
        this.mouseJoystickSource = new MouseJoystickSource(screenCanvas);

        const cubMonitor = document.getElementById("cub-monitor");
        const onCubMouseEvent = (evt) => {
            audioHandler.tryResume();
            if (document.activeElement !== document.body) document.activeElement.blur();
            const screenRect = screenCanvas.getBoundingClientRect();
            const { x, y } = calculateMouseCoordinates(evt, screenRect);

            // Handle touchscreen
            if (processor.touchScreen) processor.touchScreen.onMouse(x, y, evt.buttons);

            // Handle mouse joystick if enabled
            if (urlState.params.mouseJoystickEnabled && this.mouseJoystickSource.isEnabled()) {
                // Use the API methods instead of direct manipulation
                this.mouseJoystickSource.onMouseMove(x, y);

                // Handle button events
                if (evt.type === "mousedown" && evt.button === 0) {
                    this.mouseJoystickSource.onMouseDown(0);
                } else if (evt.type === "mouseup" && evt.button === 0) {
                    this.mouseJoystickSource.onMouseUp(0);
                }
            }

            evt.preventDefault();
        };
        for (const eventType of ["mousemove", "mousedown", "mouseup"]) {
            cubMonitor.addEventListener(eventType, onCubMouseEvent);
        }
    }

    /** Helper to manage ADC source configuration */
    updateAdcSources(mouseJoystickEnabled, microphoneChannel) {
        const { processor } = this;
        // Default all channels to the gamepad source.
        for (let ch = 0; ch < AdcChannelCount; ch++) {
            processor.adconverter.setChannelSource(ch, this.gamepadSource);
        }

        // Apply mouse joystick if enabled (takes priority on channels 0 & 1)
        if (mouseJoystickEnabled) {
            processor.adconverter.setChannelSource(0, this.mouseJoystickSource);
            processor.adconverter.setChannelSource(1, this.mouseJoystickSource);
            this.mouseJoystickSource.setVia(processor.sysvia);
        } else {
            this.mouseJoystickSource.setVia(null);
        }

        // Apply microphone if configured (can override any channel)
        if (microphoneChannel === undefined) return;
        if (Number.isInteger(microphoneChannel) && microphoneChannel >= 0 && microphoneChannel < AdcChannelCount) {
            processor.adconverter.setChannelSource(microphoneChannel, this.microphoneInput);
        } else {
            toast(
                `There is no analogue channel ${microphoneChannel}; channels are 0 to 3. ` +
                    `The microphone channel has been turned off.`,
                { title: "Microphone" },
            );
            this.clearMicrophoneChannel();
        }
    }

    clearMicrophoneChannel() {
        this.config.setMicrophoneChannel(undefined);
        delete this.urlState.params.microphoneChannel;
        this.urlState.updateUrl();
    }

    async ensureMicrophoneRunning() {
        const { microphoneInput } = this;
        if (microphoneInput.audioContext && microphoneInput.audioContext.state !== "running") {
            try {
                await microphoneInput.audioContext.resume();
                console.log("Microphone: Audio context resumed, new state:", microphoneInput.audioContext.state);
            } catch (err) {
                console.error("Microphone: Error resuming audio context:", err);
                return false;
            }
        }
        return true;
    }

    async setupMicrophone() {
        // The channel can have been turned off between the request and now.
        if (this.urlState.params.microphoneChannel === undefined) return;
        const micPermissionStatus = document.getElementById("micPermissionStatus");
        micPermissionStatus.textContent = "Requesting microphone access...";

        // Try to initialise the microphone
        const success = await this.microphoneInput.initialise();
        if (success) {
            // Note: Channel assignment is handled by updateAdcSources()
            micPermissionStatus.textContent = "Microphone connected successfully";
            await this.ensureMicrophoneRunning();

            // Try starting audio context from user gesture
            const tryAgain = async () => {
                if (await this.ensureMicrophoneRunning()) document.removeEventListener("click", tryAgain);
            };
            document.addEventListener("click", tryAgain);
        } else {
            micPermissionStatus.textContent = `Error: ${this.microphoneInput.getErrorMessage() || "Unknown error"}`;
            this.clearMicrophoneChannel();
        }
    }
}

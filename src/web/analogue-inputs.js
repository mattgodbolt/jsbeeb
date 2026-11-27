import { GamepadSource } from "../gamepad-source.js";
import { MicrophoneInput } from "./microphone-input.js";
import { MouseJoystickSource } from "../mouse-joystick-source.js";
import { AmxMouseInput } from "./amx-mouse-input.js";
import { calculateMouseCoordinates } from "../mouse-coordinates.js";
import { toast } from "./toast.js";

const AdcChannelCount = 4;

/**
 * What feeds the analogue port, the touchscreen and the AMX mouse: the gamepad,
 * the mouse acting as a joystick, and the microphone, with the mouse on the
 * monitor routed to whichever of them wants it.
 */
export class AnalogueInputs {
    /**
     * @param {object} options
     * @param {object} options.processor - the machine whose ADC and touchscreen the inputs feed
     * @param {HTMLCanvasElement} options.screenCanvas - the screen, which mouse positions are measured across
     * @param {() => Gamepad[]} options.getGamepads
     * @param {import("./settings.js").Settings} options.settings
     * @param {object} options.audioHandler - woken by any mouse event on the monitor
     * @param {(x: number, y: number) => boolean} options.takeScreenClick - offered each left click on the screen,
     *     at 0 to 1 across and down it, before the machine; true when it took the click
     * @param {(event: MouseEvent, x: number, y: number) => boolean} options.takeScreenMenu - offered each right click
     *     on the screen, as `takeScreenClick` is, before the browser's own menu; true when it took the click
     */
    constructor({ processor, screenCanvas, getGamepads, settings, audioHandler, takeScreenClick, takeScreenMenu }) {
        this.processor = processor;
        this.settings = settings;

        this.gamepadSource = new GamepadSource(getGamepads);
        // Create MicrophoneInput but don't enable by default
        this.microphoneInput = new MicrophoneInput();
        this.microphoneInput.setErrorCallback((message) => {
            toast(`${message} The microphone channel has been turned off.`, { title: "Microphone" });
        });

        // Create MouseJoystickSource but don't enable by default
        this.mouseJoystickSource = new MouseJoystickSource(screenCanvas);

        const cubMonitor = document.getElementById("cub-monitor");
        const amxMouseInput =
            processor.amxMouse && new AmxMouseInput({ mouse: processor.amxMouse, target: cubMonitor, screenCanvas });
        const screenPoint = (evt) => calculateMouseCoordinates(evt, screenCanvas.getBoundingClientRect());
        const onCubMouseEvent = (evt) => {
            audioHandler.tryResume();
            if (document.activeElement !== document.body) document.activeElement.blur();
            const { x, y } = screenPoint(evt);
            // Preventing a mousedown's default also stops the browser moving focus into a cross-site frame.
            if (evt.type === "mousedown") window.focus();
            evt.preventDefault();
            if (evt.type === "mousedown" && evt.button === 0 && takeScreenClick(x, y)) return;
            amxMouseInput?.onMouseEvent(evt);

            // Handle touchscreen
            if (processor.touchScreen) processor.touchScreen.onMouse(x, y, evt.buttons);

            // Handle mouse joystick if enabled
            if (settings.mouseJoystickEnabled && this.mouseJoystickSource.isEnabled()) {
                // Use the API methods instead of direct manipulation
                this.mouseJoystickSource.onMouseMove(x, y);

                // Handle button events
                if (evt.type === "mousedown" && evt.button === 0) {
                    this.mouseJoystickSource.onMouseDown(0);
                } else if (evt.type === "mouseup" && evt.button === 0) {
                    this.mouseJoystickSource.onMouseUp(0);
                }
            }
        };
        for (const eventType of ["mousemove", "mousedown", "mouseup"]) {
            cubMonitor.addEventListener(eventType, onCubMouseEvent);
        }
        cubMonitor.addEventListener("contextmenu", (evt) => {
            const { x, y } = screenPoint(evt);
            if (takeScreenMenu(evt, x, y)) evt.preventDefault();
        });
    }

    /** Helper to manage ADC source configuration */
    updateAdcSources(mouseJoystickEnabled, microphoneChannel) {
        const { processor } = this;
        const sources = Array(AdcChannelCount).fill(this.gamepadSource);
        if (mouseJoystickEnabled) sources[0] = sources[1] = this.mouseJoystickSource;
        const microphoneChannelExists =
            Number.isInteger(microphoneChannel) && microphoneChannel >= 0 && microphoneChannel < AdcChannelCount;
        if (microphoneChannelExists) sources[microphoneChannel] = this.microphoneInput;

        processor.adconverter.setChannelSources(sources);
        this.mouseJoystickSource.setVia(mouseJoystickEnabled ? processor.sysvia : null);

        if (microphoneChannel !== undefined && !microphoneChannelExists) {
            toast(
                `There is no analogue channel ${microphoneChannel}; channels are 0 to 3. ` +
                    `The microphone channel has been turned off.`,
                { title: "Microphone" },
            );
            this.clearMicrophoneChannel();
        }
    }

    clearMicrophoneChannel() {
        this.settings.set({ microphoneChannel: undefined });
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
        if (this.settings.microphoneChannel === undefined) return;
        const micPermissionStatus = document.getElementById("micPermissionStatus");
        micPermissionStatus.textContent = "Requesting microphone access...";

        // Try to initialise the microphone
        const { disposeCount } = this.microphoneInput;
        const success = await this.microphoneInput.initialise();
        // Turned off while waiting; any later setup owns the status and the setting.
        if (this.microphoneInput.disposeCount !== disposeCount) return;
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

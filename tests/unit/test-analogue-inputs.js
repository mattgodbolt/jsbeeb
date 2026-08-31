// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalogueInputs } from "../../src/web/analogue-inputs.js";

const Markup = `<div id="cub-monitor"><canvas id="screen"></canvas></div><span id="micPermissionStatus"></span>`;

describe("AnalogueInputs", () => {
    let deps;
    let channels;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = Markup;
        channels = {};
        deps = {
            processor: {
                adconverter: { setChannelSource: vi.fn((ch, source) => (channels[ch] = source)) },
                sysvia: {},
                touchScreen: { onMouse: vi.fn() },
            },
            screenCanvas: document.getElementById("screen"),
            getGamepads: () => [],
            urlState: { params: {}, updateUrl: vi.fn() },
            config: { setMicrophoneChannel: vi.fn() },
            audioHandler: { tryResume: vi.fn() },
        };
    });

    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
    });

    const make = () => new AnalogueInputs(deps);

    describe("who feeds the analogue channels", () => {
        it("gives every channel to the gamepad by default", () => {
            const inputs = make();
            inputs.updateAdcSources(false, undefined);
            expect(Object.keys(channels)).toHaveLength(4);
            for (let ch = 0; ch < 4; ch++) expect(channels[ch]).toBe(inputs.gamepadSource);
        });

        it("gives the mouse joystick channels 0 and 1 when enabled", () => {
            const inputs = make();
            inputs.updateAdcSources(true, undefined);
            expect(channels[0]).toBe(inputs.mouseJoystickSource);
            expect(channels[1]).toBe(inputs.mouseJoystickSource);
            expect(channels[2]).toBe(inputs.gamepadSource);
        });

        it("lets the microphone take any channel, even from the mouse", () => {
            const inputs = make();
            inputs.updateAdcSources(true, 1);
            expect(channels[0]).toBe(inputs.mouseJoystickSource);
            expect(channels[1]).toBe(inputs.microphoneInput);
        });

        it("lets the microphone take the first and last channels", () => {
            const inputs = make();
            inputs.updateAdcSources(false, 0);
            expect(channels[0]).toBe(inputs.microphoneInput);
            inputs.updateAdcSources(false, 3);
            expect(channels[3]).toBe(inputs.microphoneInput);
        });

        it("refuses a channel that does not exist, says so, and clears the setting", () => {
            deps.urlState.params.microphoneChannel = 5;
            const inputs = make();
            inputs.updateAdcSources(false, 5);
            for (let ch = 0; ch < 4; ch++) expect(channels[ch]).toBe(inputs.gamepadSource);
            expect(document.querySelector(".toast .message").textContent).toContain("no analogue channel 5");
            expect(deps.config.setMicrophoneChannel).toHaveBeenCalledWith(undefined);
            expect(deps.urlState.params.microphoneChannel).toBeUndefined();
            expect(deps.urlState.updateUrl).toHaveBeenCalled();
        });
    });

    describe("the mouse on the monitor", () => {
        const mouse = (type) => {
            const event = new MouseEvent(type, { bubbles: true, cancelable: true, buttons: 1, button: 0 });
            document.getElementById("cub-monitor").dispatchEvent(event);
            return event;
        };

        it("wakes the audio and feeds the touchscreen", () => {
            make();
            const event = mouse("mousedown");
            expect(deps.audioHandler.tryResume).toHaveBeenCalled();
            expect(deps.processor.touchScreen.onMouse).toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(true);
        });

        it("drives the mouse joystick's button only when it is enabled", () => {
            const inputs = make();
            const down = vi.spyOn(inputs.mouseJoystickSource, "onMouseDown");
            mouse("mousedown");
            expect(down).not.toHaveBeenCalled();

            deps.urlState.params.mouseJoystickEnabled = true;
            vi.spyOn(inputs.mouseJoystickSource, "isEnabled").mockReturnValue(true);
            mouse("mousedown");
            expect(down).toHaveBeenCalledWith(0);
        });
    });

    describe("a microphone whose channel was turned off", () => {
        it("never asks for microphone access", async () => {
            const inputs = make();
            const initialise = vi.spyOn(inputs.microphoneInput, "initialise");
            await inputs.setupMicrophone();
            expect(initialise).not.toHaveBeenCalled();
        });
    });

    describe("a microphone that cannot start", () => {
        it("reports, clears the setting and takes it out of the URL", async () => {
            deps.urlState.params.microphoneChannel = 2;
            const inputs = make();
            vi.spyOn(inputs.microphoneInput, "initialise").mockResolvedValue(false);
            vi.spyOn(inputs.microphoneInput, "getErrorMessage").mockReturnValue("denied");
            await inputs.setupMicrophone();
            expect(document.getElementById("micPermissionStatus").textContent).toBe("Error: denied");
            expect(deps.config.setMicrophoneChannel).toHaveBeenCalledWith(undefined);
            expect(deps.urlState.params.microphoneChannel).toBeUndefined();
            expect(deps.urlState.updateUrl).toHaveBeenCalled();
        });
    });
});

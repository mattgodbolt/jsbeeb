// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnalogueInputs } from "../../src/web/analogue-inputs.js";
import { Adc } from "../../src/adc.js";
import { AmxButtons } from "../../src/amx-mouse.js";
import { Scheduler } from "../../src/scheduler.js";
import { Settings } from "../../src/web/settings.js";
import { domFromIndexHtml, fakeUrlState, teardownDom, toasts } from "./helpers.js";

describe("AnalogueInputs", () => {
    let deps;
    let channels;

    beforeEach(() => {
        vi.useFakeTimers();
        domFromIndexHtml("cub-monitor");
        document.body.append(Object.assign(document.createElement("div"), { id: "micPermissionStatus" }));
        const adconverter = new Adc({}, new Scheduler());
        channels = adconverter.channelSources;
        deps = {
            processor: {
                adconverter,
                sysvia: {},
                touchScreen: { onMouse: vi.fn() },
            },
            screenCanvas: document.getElementById("screen"),
            getGamepads: () => [],
            settings: new Settings({ urlState: fakeUrlState() }),
            audioHandler: { tryResume: vi.fn() },
            takeScreenClick: () => false,
            takeScreenMenu: () => false,
        };
        vi.spyOn(deps.settings.urlState, "updateUrl");
    });

    afterEach(teardownDom);

    const make = () => new AnalogueInputs(deps);

    describe("who feeds the analogue channels", () => {
        it("gives every channel to the gamepad by default", () => {
            const inputs = make();
            inputs.updateAdcSources(false, undefined);
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

        it("keeps the microphone running through every reroute until it is turned off", () => {
            const inputs = make();
            inputs.updateAdcSources(true, 0);
            const disposeMicrophone = vi.spyOn(inputs.microphoneInput, "dispose");
            inputs.updateAdcSources(false, 0);
            inputs.updateAdcSources(false, 3);
            inputs.updateAdcSources(true, 0);
            expect(disposeMicrophone).not.toHaveBeenCalled();
            expect(channels[0]).toBe(inputs.microphoneInput);
            expect(inputs.mouseJoystickSource.isEnabled()).toBe(true);
            inputs.updateAdcSources(true, undefined);
            expect(disposeMicrophone).toHaveBeenCalledTimes(1);
        });

        it("refuses a channel that does not exist, says so, and clears the setting", () => {
            deps.settings.microphoneChannel = 5;
            deps.settings.urlState.params.microphoneChannel = 5;
            const inputs = make();
            inputs.updateAdcSources(false, 5);
            for (let ch = 0; ch < 4; ch++) expect(channels[ch]).toBe(inputs.gamepadSource);
            expect(toasts()).toEqual([expect.stringContaining("no analogue channel 5")]);
            expect(deps.settings.microphoneChannel).toBeUndefined();
            expect(deps.settings.urlState.params.microphoneChannel).toBeUndefined();
            expect(deps.settings.urlState.updateUrl).toHaveBeenCalled();
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

            deps.settings.mouseJoystickEnabled = true;
            vi.spyOn(inputs.mouseJoystickSource, "isEnabled").mockReturnValue(true);
            mouse("mousedown");
            expect(down).toHaveBeenCalledWith(0);
        });

        it("offers a left click to the debugger first, and gives the machine only those it leaves", () => {
            deps.takeScreenClick = vi.fn(() => true);
            make();
            const taken = mouse("mousedown");
            expect(deps.takeScreenClick).toHaveBeenCalledTimes(1);
            expect(deps.processor.touchScreen.onMouse).not.toHaveBeenCalled();
            expect(taken.defaultPrevented).toBe(true);
            mouse("mousemove");
            expect(deps.takeScreenClick).toHaveBeenCalledTimes(1);
            expect(deps.processor.touchScreen.onMouse).toHaveBeenCalledTimes(1);
        });

        it.each([
            ["keeps the browser's menu off the screen when the debugger takes a right click", true],
            ["leaves the browser's menu to a right click the debugger does not take", false],
        ])("%s", (_, taken) => {
            deps.takeScreenMenu = vi.fn(() => taken);
            make();
            const event = mouse("contextmenu");
            expect(deps.takeScreenMenu).toHaveBeenCalledWith(event, expect.any(Number), expect.any(Number));
            expect(event.defaultPrevented).toBe(taken);
        });
    });

    describe("the AMX mouse", () => {
        const ScreenWidth = 896;
        let amxMouse;
        let monitor;

        const send = (type, { button = 0, buttons = 0, movementX = 0, movementY = 0 } = {}) => {
            const event = new MouseEvent(type, { bubbles: true, cancelable: true, button, buttons });
            Object.defineProperties(event, { movementX: { value: movementX }, movementY: { value: movementY } });
            monitor.dispatchEvent(event);
        };
        const lockTo = (element) =>
            Object.defineProperty(document, "pointerLockElement", { value: element, configurable: true });

        beforeEach(() => {
            amxMouse = { move: vi.fn(), setButtons: vi.fn() };
            deps.processor.amxMouse = amxMouse;
            monitor = document.getElementById("cub-monitor");
            monitor.requestPointerLock = vi.fn(async () => lockTo(monitor));
            vi.spyOn(deps.screenCanvas, "getBoundingClientRect").mockReturnValue({ width: ScreenWidth });
        });

        afterEach(() => lockTo(null));

        it("locks the pointer with the first click, which presses nothing, and presses buttons after", () => {
            make();
            send("mousedown", { buttons: 1 });
            expect(monitor.requestPointerLock).toHaveBeenCalledTimes(1);
            expect(amxMouse.setButtons).not.toHaveBeenCalled();
            lockTo(monitor);
            send("mouseup");
            send("mousedown", { buttons: 1 | 2 | 4 });
            expect(amxMouse.setButtons.mock.calls).toEqual([
                [0],
                [AmxButtons.left | AmxButtons.right | AmxButtons.middle],
            ]);
        });

        it("leaves a right click on the unlocked screen to the right-click menu", () => {
            make();
            send("mousedown", { button: 2, buttons: 2 });
            expect(monitor.requestPointerLock).not.toHaveBeenCalled();
            expect(amxMouse.setButtons).not.toHaveBeenCalled();
        });

        it.each([
            ["reports a pointerlockerror", () => document.dispatchEvent(new Event("pointerlockerror"))],
            [
                "rejects the request",
                () => {
                    monitor.requestPointerLock = vi.fn(() => Promise.reject(new Error("refused")));
                    send("mousedown", { buttons: 1 });
                },
            ],
        ])(
            "presses a button with each click after the browser %s, asking for the lock again with a left click",
            async (_, refuse) => {
                make();
                refuse();
                await Promise.resolve();
                amxMouse.setButtons.mockClear();
                monitor.requestPointerLock = vi.fn(async () => {});
                send("mousedown", { button: 2, buttons: 2 });
                expect(monitor.requestPointerLock).not.toHaveBeenCalled();
                send("mousedown", { button: 0, buttons: 1 | 2 });
                expect(monitor.requestPointerLock).toHaveBeenCalledTimes(1);
                expect(amxMouse.setButtons.mock.calls).toEqual([
                    [AmxButtons.right],
                    [AmxButtons.left | AmxButtons.right],
                ]);
            },
        );

        it("lets go of the buttons as the lock goes, and locks again with the next click", () => {
            make();
            lockTo(monitor);
            document.dispatchEvent(new Event("pointerlockchange"));
            send("mousedown", { buttons: 1 });
            lockTo(null);
            document.dispatchEvent(new Event("pointerlockchange"));
            expect(amxMouse.setButtons).toHaveBeenLastCalledWith(0);
            amxMouse.setButtons.mockClear();
            send("mousedown", { buttons: 1 });
            expect(monitor.requestPointerLock).toHaveBeenCalledTimes(1);
            expect(amxMouse.setButtons).not.toHaveBeenCalled();
        });

        it("moves as far as the pointer moves across the screen, up as it goes up, keeping what is left over", () => {
            make();
            for (let i = 0; i < 3; ++i) send("mousemove", { movementX: 0.2, movementY: -0.2 });
            send("mousemove", { movementX: -ScreenWidth / 2 });
            expect(amxMouse.move.mock.calls).toEqual([
                [1, 1],
                [-895, 0],
            ]);
        });

        it("presses a button with each click where the browser has no pointer lock", () => {
            delete monitor.requestPointerLock;
            make();
            send("mousedown", { buttons: 4 });
            expect(amxMouse.setButtons).toHaveBeenCalledWith(AmxButtons.middle);
        });

        it("takes nothing from the mouse where the machine has none", () => {
            delete deps.processor.amxMouse;
            make();
            send("mousedown", { buttons: 1 });
            expect(monitor.requestPointerLock).not.toHaveBeenCalled();
        });
    });

    describe("a microphone waiting for access", () => {
        it("reads as silence on the channel it was given", () => {
            const inputs = make();
            inputs.updateAdcSources(false, 2);
            expect(channels[2].getValue(2)).toBe(0);
        });
    });

    describe("a microphone with access", () => {
        const Silence = 128;
        let getUserMedia;
        let stopTrack;

        beforeEach(() => {
            stopTrack = vi.fn();
            getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
            vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
            vi.stubGlobal(
                "AudioContext",
                class {
                    state = "running";
                    createAnalyser = () => ({
                        frequencyBinCount: 4,
                        getByteTimeDomainData: (data) => data.fill(Silence),
                    });
                    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
                    close = async () => {};
                },
            );
        });

        it("keeps its stream when it moves to another channel, and stops it when turned off", async () => {
            deps.settings.microphoneChannel = 2;
            const inputs = make();
            inputs.updateAdcSources(false, 2);
            await inputs.setupMicrophone();
            inputs.updateAdcSources(false, 3);
            await inputs.setupMicrophone();
            expect(getUserMedia).toHaveBeenCalledTimes(1);
            expect(channels[3].getValue(3)).toBe(0);
            expect(stopTrack).not.toHaveBeenCalled();
            inputs.updateAdcSources(false, undefined);
            expect(stopTrack).toHaveBeenCalledTimes(1);
        });

        it("shares an in-flight permission request when the microphone moves channels", async () => {
            const pending = [];
            const stopped = [];

            getUserMedia.mockImplementation(
                () =>
                    new Promise((resolve) => {
                        const stop = vi.fn();
                        stopped.push(stop);
                        pending.push(() => resolve({ getTracks: () => [{ stop }] }));
                    }),
            );

            deps.settings.microphoneChannel = 2;
            const inputs = make();
            inputs.updateAdcSources(false, 2);

            const firstSetup = inputs.setupMicrophone();

            deps.settings.microphoneChannel = 3;
            inputs.updateAdcSources(false, 3);

            const secondSetup = inputs.setupMicrophone();

            pending.forEach((resolve) => resolve());

            await Promise.all([firstSetup, secondSetup]);

            inputs.updateAdcSources(false, undefined);

            expect(getUserMedia).toHaveBeenCalledTimes(1);
            expect(stopped).toHaveLength(1);
            expect(stopped[0]).toHaveBeenCalledOnce();
        });

        describe("turned off during the permission prompt", () => {
            const grants = [];
            const denials = [];
            const stops = [];
            const status = () => document.getElementById("micPermissionStatus").textContent;

            beforeEach(() => {
                grants.length = denials.length = stops.length = 0;
                getUserMedia.mockImplementation(
                    () =>
                        new Promise((resolve, reject) => {
                            const stop = vi.fn();
                            stops.push(stop);
                            grants.push(() => resolve({ getTracks: () => [{ stop }] }));
                            denials.push(() => reject(new Error("Permission denied")));
                        }),
                );
            });

            const turnOn = (inputs, channel) => {
                deps.settings.microphoneChannel = channel;
                inputs.updateAdcSources(false, channel);
                return channel === undefined ? Promise.resolve() : inputs.setupMicrophone();
            };

            it.each([
                ["granted", grants, 1],
                ["denied", denials, 0],
            ])("reports no error when the prompt is then %s, and stops any stream", async (_, answers, stopCount) => {
                const inputs = make();
                const setup = turnOn(inputs, 2);
                turnOn(inputs, undefined);
                answers.forEach((answer) => answer());
                await setup;

                expect(stops[0]).toHaveBeenCalledTimes(stopCount);
                expect(toasts()).toEqual([]);
                expect(status()).not.toMatch(/Error/);
            });

            it("starts afresh when turned back on before the first prompt is answered", async () => {
                const inputs = make();
                const firstSetup = turnOn(inputs, 2);
                turnOn(inputs, undefined);
                const secondSetup = turnOn(inputs, 3);
                grants.forEach((grant) => grant());
                await Promise.all([firstSetup, secondSetup]);

                expect(stops).toHaveLength(2);
                expect(stops[0]).toHaveBeenCalledOnce();
                expect(stops[1]).not.toHaveBeenCalled();
                expect(deps.settings.microphoneChannel).toBe(3);
                expect(status()).toBe("Microphone connected successfully");
                expect(toasts()).toEqual([]);
            });
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
            deps.settings.microphoneChannel = 2;
            deps.settings.urlState.params.microphoneChannel = 2;
            const inputs = make();
            vi.spyOn(inputs.microphoneInput, "initialise").mockResolvedValue(false);
            vi.spyOn(inputs.microphoneInput, "getErrorMessage").mockReturnValue("denied");
            await inputs.setupMicrophone();
            expect(document.getElementById("micPermissionStatus").textContent).toBe("Error: denied");
            expect(deps.settings.microphoneChannel).toBeUndefined();
            expect(deps.settings.urlState.params.microphoneChannel).toBeUndefined();
            expect(deps.settings.urlState.updateUrl).toHaveBeenCalled();
        });
    });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Config, fittedRoms, needsRestart, restartPending } from "../../src/web/config.js";
import { allModels, findModel } from "../../src/models.js";
import { Parameters } from "../../src/web/parameters.js";
import { Settings } from "../../src/web/settings.js";
import { domFromIndexHtml, fakeUrlState, teardownDom } from "./helpers.js";

const menuText = (id) => document.getElementById(id).textContent.trim();
const dialog = () => document.getElementById("configuration");
const openDialog = () => dialog().dispatchEvent(new Event("show.bs.modal", { bubbles: true }));
const closeDialog = () => dialog().dispatchEvent(new Event("hide.bs.modal", { bubbles: true }));

describe("fittedRoms", () => {
    const master = findModel("Master");
    const none = { model: findModel("B-DFS1.2"), hasEconet: false, hasMusic5000: false, hasTeletextAdaptor: false };
    const everything = { model: master, hasEconet: true, hasMusic5000: true, hasTeletextAdaptor: true };

    it.each([
        ["nothing when nothing is enabled", none, []],
        ["the Music 5000 ROM", { ...none, hasMusic5000: true }, ["ample.rom"]],
        ["the teletext ROM", { ...none, hasTeletextAdaptor: true }, ["ats-3.0.rom"]],
        ["ANFS on a Master", { ...none, model: master, hasEconet: true }, ["master/anfs-4.25.rom"]],
        ["no ANFS on a B", { ...none, hasEconet: true }, []],
        ["everything in bank allocation order", everything, ["master/anfs-4.25.rom", "ample.rom", "ats-3.0.rom"]],
    ])("fits %s", (_, fittings, roms) => {
        expect(fittedRoms(fittings)).toEqual(roms);
    });

    it("gives the same answer however many times it is asked", () => {
        expect(fittedRoms(everything)).toEqual(fittedRoms(everything));
    });
});

describe("what needs a restart", () => {
    const parameters = { fitted: { field: { restart: true } }, live: { field: {} } };

    it.each([
        [{}, false],
        [{ live: true }, false],
        [{ fitted: true }, true],
        [{ fitted: false }, true],
        [{ live: true, fitted: true }, true],
    ])("is needed for the changes %o: %s", (changed, needed) => {
        expect(needsRestart(changed, parameters)).toBe(needed);
    });

    it.each([
        [{ fitted: false, live: 1 }, false],
        [{ fitted: true, live: 1 }, true],
        [{ fitted: false, live: 2 }, false],
    ])("is pending for the settings %o on a machine built without the fitting: %s", (settings, pending) => {
        expect(restartPending(settings, { fitted: false, live: 1 }, parameters)).toBe(pending);
    });

    it("is needed for the model and the fittings, and nothing else", () => {
        expect(
            Object.keys(Parameters)
                .filter((name) => Parameters[name].field?.restart)
                .sort(),
        ).toEqual(["coProcessor", "hasEconet", "hasMusic5000", "hasTeletextAdaptor", "hasVideoNula", "model"]);
    });
});

describe("Config", () => {
    let settings;
    let changed;
    let restartRequired;
    let config;

    const modelDropdownText = () => menuText("bbc-model-dropdown");
    const restartPendingShown = () => !document.getElementById("restart-pending").classList.contains("d-none");
    const clickModel = (synonym) => document.querySelector(`.model-menu a[data-target="${synonym}"]`).click();
    const tubeSlider = () => document.getElementById("tubeCpuMultiplier");
    const dragTubeSlider = (value) => {
        tubeSlider().value = value;
        tubeSlider().dispatchEvent(new Event("input"));
    };
    const lastSaved = () => changed.mock.calls.at(-1)[0];

    beforeEach(() => {
        domFromIndexHtml("configuration");
        settings = new Settings({ urlState: fakeUrlState("?model=B-DFS1.2") });
        changed = vi.fn();
        settings.addEventListener("change", (event) => changed(event.detail));
        restartRequired = vi.fn();
        config = new Config(settings);
        config.addEventListener("restart-required", restartRequired);
    });

    afterEach(teardownDom);

    describe("the model menu", () => {
        it("offers every selectable model under its first synonym, in catalogue order", () => {
            const selectable = allModels.filter((model) => model.synonyms.length > 0);
            const items = [...document.querySelectorAll(".model-menu a")];
            expect(items.map((item) => item.textContent)).toEqual(selectable.map((model) => model.name));
            expect(items.map((item) => item.dataset.target)).toEqual(selectable.map((model) => model.synonyms[0]));
        });

        it("shows the chosen model without adopting it until the dialog closes", () => {
            openDialog();
            clickModel("Master");
            expect(modelDropdownText()).toBe(findModel("Master").name);
            expect(settings.model).toBe(findModel("B-DFS1.2"));
            closeDialog();
            expect(settings.model).toBe(findModel("Master"));
        });
    });

    describe("opening the dialog", () => {
        it("forgets a previous visit's changes", () => {
            openDialog();
            clickModel("Master");
            closeDialog();
            changed.mockClear();
            openDialog();
            closeDialog();
            expect(changed).not.toHaveBeenCalled();
        });
    });

    describe("closing the dialog", () => {
        it("saves nothing from an untouched dialog", () => {
            openDialog();
            closeDialog();
            expect(changed).not.toHaveBeenCalled();
            expect(restartRequired).not.toHaveBeenCalled();
        });

        it("saves the touched settings together", () => {
            openDialog();
            clickModel("Master");
            document.getElementById("hasMusic5000").click();
            closeDialog();
            expect(changed).toHaveBeenCalledWith({ model: "Master", hasMusic5000: true });
            expect(settings.hasMusic5000).toBe(true);
            expect(settings.urlState.params.hasMusic5000).toBe(true);
        });
    });

    describe("a change that needs a restart", () => {
        it("warns as soon as the model is picked and asks for the restart on close", () => {
            openDialog();
            expect(restartPendingShown()).toBe(false);
            clickModel("Master");
            expect(restartPendingShown()).toBe(true);
            closeDialog();
            expect(restartRequired).toHaveBeenCalledTimes(1);
        });

        it("stops asking once the setting is put back", () => {
            openDialog();
            document.getElementById("hasMusic5000").click();
            closeDialog();
            expect(restartRequired).toHaveBeenCalledTimes(1);
            openDialog();
            document.getElementById("hasMusic5000").click();
            expect(restartPendingShown()).toBe(false);
            closeDialog();
            expect(lastSaved()).toEqual({ hasMusic5000: false });
            expect(restartRequired).toHaveBeenCalledTimes(1);
        });

        it("does not ask when a touched control is back where the machine already is", () => {
            openDialog();
            document.getElementById("hasMusic5000").click();
            document.getElementById("hasMusic5000").click();
            closeDialog();
            expect(lastSaved()).toEqual({ hasMusic5000: false });
            expect(restartRequired).not.toHaveBeenCalled();
        });
    });

    describe("the VideoNuLA control", () => {
        const nula = () => document.getElementById("hasVideoNula");

        it("fits a VideoNuLA from the next start and puts it in the URL", () => {
            openDialog();
            nula().click();
            closeDialog();
            expect(lastSaved()).toEqual({ hasVideoNula: true });
            expect(settings.urlState.params.hasVideoNula).toBe(true);
            expect(restartRequired).toHaveBeenCalledTimes(1);
        });

        it("offers a VideoNuLA on a BBC Micro but not an Atom", () => {
            openDialog();
            clickModel("Master");
            expect(nula().disabled).toBe(false);
            clickModel("Atom");
            expect(nula().disabled).toBe(true);
            clickModel("B-DFS1.2");
            expect(nula().disabled).toBe(false);
        });
    });

    describe("the co-processor controls", () => {
        it("only lets the tube speed be set while the co-processor is ticked", () => {
            openDialog();
            document.getElementById("coProcessor").click();
            expect(tubeSlider().disabled).toBe(false);
            document.getElementById("coProcessor").click();
            expect(tubeSlider().disabled).toBe(true);
        });

        it("labels a dragged tube speed with the machine it will drive", () => {
            openDialog();
            dragTubeSlider(2);
            expect(document.getElementById("tubeCpuMultiplierValue").textContent).toBe("2x (6MHz)");
            closeDialog();
            expect(settings.tubeCpuMultiplier).toBe(2);
        });

        it("labels the tube speed for a newly picked model's own second processor", () => {
            openDialog();
            clickModel("Master");
            expect(document.getElementById("tubeCpuMultiplierValue").textContent).toBe("1x (4MHz)");
        });
    });

    describe("the dropdown pickers", () => {
        it.each([
            [
                "a keyboard layout",
                ".key-layout-menu a[data-value=natural]",
                "keyLayoutDropdown",
                "Natural",
                "keyLayout",
                "natural",
            ],
            [
                "a microphone channel",
                ".microphone-channel-option[data-value='2']",
                "microphoneChannelDropdown",
                "Channel 2",
                "microphoneChannel",
                2,
            ],
        ])("shows %s picked and saves it on close", (_, option, dropdown, shown, setting, saved) => {
            openDialog();
            document.querySelector(option).click();
            expect(menuText(dropdown)).toBe(shown);
            closeDialog();
            expect(settings[setting]).toBe(saved);
        });

        it("saves disabling the microphone as a change, not an omission", () => {
            openDialog();
            document.querySelector('.microphone-channel-option[data-value=""]').click();
            expect(menuText("microphoneChannelDropdown")).toBe("Disabled");
            closeDialog();
            expect(lastSaved()).toStrictEqual({ microphoneChannel: undefined });
        });
    });

    describe("the live settings", () => {
        it("sets a sound output at once, without waiting for the dialog to close", () => {
            openDialog();
            document.querySelector('.audio-output-option[data-output="board"]').click();
            expect(settings.audioOutput).toBe("board");
            expect(menuText("audioOutputDropdown")).toBe("Line out");
            expect(document.getElementById("speakerAmount").disabled).toBe(true);
            closeDialog();
            expect(changed).toHaveBeenCalledTimes(1);
        });

        it("sets a display mode at once and shows its name", () => {
            openDialog();
            document.querySelector('.display-mode-option[data-value="pal"]').click();
            expect(settings.displayMode).toBe("pal");
            expect(menuText("displayModeDropdown")).toBe("PAL TV");
        });

        it("sets a dragged speaker amount at once", () => {
            const slider = document.getElementById("speakerAmount");
            slider.value = 0.5;
            slider.dispatchEvent(new Event("input"));
            expect(settings.speakerAmount).toBe(0.5);
        });

        it("gives the persistence slider to the showing display, and no display without one", () => {
            const slider = document.getElementById("persistence");
            const readout = () => document.getElementById("persistenceValue").textContent;
            settings.set({ displayMode: "pal" });
            expect(slider.disabled).toBe(false);
            expect(slider.value).toBe("40");
            expect(readout()).toBe("40 ms");
            slider.value = 80;
            slider.dispatchEvent(new Event("input"));
            expect(settings.palPersistenceMs).toBe(80);
            expect(settings.rgbPersistenceMs).toBe(25);
            expect(readout()).toBe("80 ms");
            settings.set({ displayMode: "rgb" });
            expect(slider.value).toBe("25");
            expect(readout()).toBe("25 ms");
            settings.set({ rgbPersistenceMs: 0 });
            expect(slider.value).toBe("0");
            expect(readout()).toBe("none");
            settings.set({ displayMode: "xbr" });
            expect(slider.disabled).toBe(true);
            expect(readout()).toBe("not available");
            slider.dispatchEvent(new Event("input"));
            expect(settings.palPersistenceMs).toBe(80);
        });

        it("gives the slider to the display actually in use when the one asked for fell back", () => {
            const slider = document.getElementById("persistence");
            settings.set({ displayMode: "pal" });
            config.setPersistenceInUse("rgbPersistenceMs");
            expect(slider.value).toBe("25");
            slider.value = 30;
            slider.dispatchEvent(new Event("input"));
            expect(settings.rgbPersistenceMs).toBe(30);
            expect(settings.palPersistenceMs).toBe(40);
        });

        it("follows a live setting changed elsewhere", () => {
            settings.set({ audioOutput: "off", displayMode: "xbr", speakerAmount: 0.25 });
            expect(menuText("audioOutputDropdown")).toBe("Unfiltered");
            expect(menuText("displayModeDropdown")).toBe("Smoothed (xBR)");
            expect(document.getElementById("speakerAmount").value).toBe("0.25");
        });
    });

    describe("naming the machine", () => {
        it("names the running model everywhere the page shows it", () => {
            expect(document.querySelector(".modal-title .bbc-model").textContent).toBe(findModel("B-DFS1.2").name);
            expect(modelDropdownText()).toBe(findModel("B-DFS1.2").name);
        });

        it("keeps naming the running model after another is saved for the next start", () => {
            openDialog();
            clickModel("Master");
            closeDialog();
            expect(document.querySelector(".modal-title .bbc-model").textContent).toBe(findModel("B-DFS1.2").name);
            openDialog();
            expect(modelDropdownText()).toBe(findModel("Master").name);
        });
    });
});

describe("the Settings form", () => {
    const Changed =
        "?model=Master&keyLayout=natural&displayMode=pal&coProcessor=true&tubeCpuMultiplier=2&hasEconet=true" +
        "&hasVideoNula=true" +
        "&audioOutput=board&speakerAmount=0.5&microphoneChannel=1&mouseJoystickEnabled=true&speechOutput=true";

    const shown = (control) =>
        control.type === "checkbox"
            ? control.checked
            : control.type === "range"
              ? control.value
              : control.textContent.trim();
    const controls = () =>
        [...dialog().querySelectorAll(".modal-body button, .modal-body input")].map((control) => ({
            id: control.id,
            label: control.labels[0].textContent,
            type: control.type,
            value: shown(control),
            disabled: control.disabled,
        }));
    const configFrom = (search) => {
        const settings = new Settings({ urlState: fakeUrlState(search) });
        return { settings, config: new Config(settings) };
    };

    beforeEach(() => domFromIndexHtml("configuration"));
    afterEach(teardownDom);

    it("labels and shows every setting", () => {
        configFrom(Changed);
        openDialog();
        expect(controls()).toEqual([
            {
                id: "bbc-model-dropdown",
                label: "Base model:(including disk interface)",
                type: "button",
                value: "BBC Master 128 (DFS)",
                disabled: false,
            },
            { id: "keyLayoutDropdown", label: "Keyboard layout:", type: "button", value: "Natural", disabled: false },
            { id: "displayModeDropdown", label: "Display mode:", type: "button", value: "PAL TV", disabled: false },
            { id: "persistence", label: "Phosphor afterglow: 40 ms", type: "range", value: "40", disabled: false },
            { id: "coProcessor", label: "65c02 co-processor", type: "checkbox", value: true, disabled: false },
            { id: "tubeCpuMultiplier", label: "Tube CPU: 2x (8MHz)", type: "range", value: "2", disabled: false },
            { id: "hasMusic5000", label: "Music 5000 synthesiser", type: "checkbox", value: false, disabled: false },
            { id: "hasTeletextAdaptor", label: "Teletext adaptor", type: "checkbox", value: false, disabled: false },
            { id: "hasEconet", label: "Econet with file server", type: "checkbox", value: true, disabled: false },
            {
                id: "hasVideoNula",
                label: "VideoNuLA (4096-colour palette)",
                type: "checkbox",
                value: true,
                disabled: false,
            },
            { id: "audioOutputDropdown", label: "Sound output:", type: "button", value: "Line out", disabled: false },
            { id: "speakerAmount", label: "Speaker character:", type: "range", value: "0.5", disabled: true },
            {
                id: "microphoneChannelDropdown",
                label: "Microphone channel:",
                type: "button",
                value: "Channel 1",
                disabled: false,
            },
            {
                id: "mouseJoystickEnabled",
                label: "Enable mouse as analogue joystick",
                type: "checkbox",
                value: true,
                disabled: false,
            },
            {
                id: "speechOutput",
                label: "Speak RS-423 serial output (*FX3,1)",
                type: "checkbox",
                value: true,
                disabled: false,
            },
        ]);
    });

    it("gives every menu its options, each carrying the value it picks", () => {
        configFrom("");
        const menu = (id) =>
            [...document.getElementById(id).nextElementSibling.querySelectorAll("a")].map((link) => ({
                text: link.textContent,
                data: { ...link.dataset },
            }));
        expect(menu("keyLayoutDropdown").map(({ data }) => data.value)).toEqual(["physical", "natural", "gaming"]);
        expect(menu("displayModeDropdown").map(({ data }) => data.value)).toEqual(["rgb", "pal", "xbr"]);
        expect(menu("audioOutputDropdown")).toEqual([
            { text: "Internal speaker", data: { output: "speaker" } },
            { text: "Line out", data: { output: "board" } },
            { text: "Unfiltered", data: { output: "off" } },
        ]);
        expect(menu("microphoneChannelDropdown").map(({ text }) => text)).toEqual([
            "Disabled",
            "Channel 0",
            "Channel 1",
            "Channel 2",
            "Channel 3",
        ]);
    });

    it("leaves the URL as it found it when the dialog is opened and closed untouched", () => {
        const { settings } = configFrom(Changed);
        const before = settings.urlState.url();
        openDialog();
        closeDialog();
        expect(settings.urlState.url()).toBe(before);
    });

    it("saves nothing on closing after the afterglow is dragged, which is no setting of its own", () => {
        const { settings } = configFrom("?displayMode=pal");
        openDialog();
        const slider = document.getElementById("persistence");
        slider.value = 30;
        slider.dispatchEvent(new Event("input"));
        const dragged = settings.urlState.url();
        closeDialog();
        expect(settings.palPersistenceMs).toBe(30);
        expect(settings.urlState.url()).toBe(dragged);
        expect(dragged).not.toContain("undefined");
    });

    it("follows a saved-on-close setting changed elsewhere while the dialog is open", () => {
        const { settings } = configFrom("");
        openDialog();
        settings.set({ microphoneChannel: 2, keyLayout: "gaming" });
        expect(menuText("microphoneChannelDropdown")).toBe("Channel 2");
        expect(menuText("keyLayoutDropdown")).toBe("Gaming");
    });

    it("keeps showing a pending pick, which is what closing saves, when its setting changes elsewhere", () => {
        const { settings } = configFrom("");
        openDialog();
        document.querySelector('.microphone-channel-option[data-value="3"]').click();
        settings.set({ microphoneChannel: 1 });
        expect(menuText("microphoneChannelDropdown")).toBe("Channel 3");
        closeDialog();
        expect(settings.microphoneChannel).toBe(3);
    });

    it("shows on opening what was saved elsewhere while it was closed", () => {
        const { settings } = configFrom("");
        openDialog();
        closeDialog();
        settings.set({ microphoneChannel: 1, keyLayout: "natural" });
        openDialog();
        expect(menuText("microphoneChannelDropdown")).toBe("Channel 1");
        expect(menuText("keyLayoutDropdown")).toBe("Natural");
    });

    it("names a model that has no synonym to pick it by", () => {
        const { settings } = configFrom("?model=Tube65C02");
        openDialog();
        expect(menuText("bbc-model-dropdown")).toBe("Tube65C02");
        closeDialog();
        expect(settings.urlState.url()).toContain("model=Tube65C02");
    });

    it("shows a fresh page what the last one saved", () => {
        const { settings } = configFrom("?model=B-DFS1.2");
        openDialog();
        document.querySelector('.model-menu a[data-target="Master"]').click();
        document.querySelector('.key-layout-menu a[data-value="natural"]').click();
        document.querySelector('.microphone-channel-option[data-value="1"]').click();
        for (const id of ["coProcessor", "hasEconet", "mouseJoystickEnabled", "speechOutput"])
            document.getElementById(id).click();
        const tube = document.getElementById("tubeCpuMultiplier");
        tube.value = 2;
        tube.dispatchEvent(new Event("input"));
        document.querySelector('.display-mode-option[data-value="pal"]').click();
        document.querySelector('.audio-output-option[data-output="board"]').click();
        const speaker = document.getElementById("speakerAmount");
        speaker.value = 0.5;
        speaker.dispatchEvent(new Event("input"));
        closeDialog();
        const picked = controls();

        const search = new URL(settings.urlState.url()).search;
        document.body.innerHTML = "";
        domFromIndexHtml("configuration");
        configFrom(search);
        openDialog();
        expect(controls()).toEqual(picked);
    });
});

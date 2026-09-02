// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { Config, fittedRoms, needsRestart, restartPending, tubeCpuSpeedLabel } from "../../src/web/config.js";
import { allModels, findModel } from "../../src/models.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

describe("fittedRoms", () => {
    const master = findModel("Master");
    const beeb = findModel("B-DFS1.2");
    const none = { model: beeb, hasEconet: false, hasMusic5000: false, hasTeletextAdaptor: false };

    it("fits nothing when nothing is enabled", () => {
        expect(fittedRoms(none)).toEqual([]);
    });

    it("fits the Music 5000 and teletext ROMs", () => {
        expect(fittedRoms({ ...none, hasMusic5000: true })).toEqual(["ample.rom"]);
        expect(fittedRoms({ ...none, hasTeletextAdaptor: true })).toEqual(["ats-3.0.rom"]);
    });

    it("fits ANFS only on a Master", () => {
        expect(fittedRoms({ ...none, model: master, hasEconet: true })).toEqual(["master/anfs-4.25.rom"]);
        expect(fittedRoms({ ...none, hasEconet: true })).toEqual([]);
    });

    it("orders the ROMs so bank allocation is predictable", () => {
        const all = { model: master, hasEconet: true, hasMusic5000: true, hasTeletextAdaptor: true };

        expect(fittedRoms(all)).toEqual(["master/anfs-4.25.rom", "ample.rom", "ats-3.0.rom"]);
    });

    it("gives the same answer however many times it is asked", () => {
        const all = { model: master, hasEconet: true, hasMusic5000: true, hasTeletextAdaptor: true };

        expect(fittedRoms(all)).toEqual(fittedRoms(all));
    });
});

describe("needsRestart", () => {
    it("says no when nothing changed", () => {
        expect(needsRestart({})).toBe(false);
    });

    it("says no for settings the running machine can follow", () => {
        expect(needsRestart({ keyLayout: "natural", displayMode: "pal", speechOutput: true })).toBe(false);
    });

    it("says yes for the model and the fittings", () => {
        expect(needsRestart({ model: "Master" })).toBe(true);
        expect(needsRestart({ coProcessor: true })).toBe(true);
        expect(needsRestart({ hasEconet: true })).toBe(true);
        expect(needsRestart({ hasMusic5000: true })).toBe(true);
        expect(needsRestart({ hasTeletextAdaptor: true })).toBe(true);
    });

    it("says yes when turning a fitting off, not just on", () => {
        expect(needsRestart({ coProcessor: false })).toBe(true);
    });

    it("says yes when a live setting changed alongside one that needs a restart", () => {
        expect(needsRestart({ speechOutput: true, coProcessor: true })).toBe(true);
    });
});

describe("restartPending", () => {
    const running = {
        model: "B-DFS1.2",
        coProcessor: false,
        hasEconet: false,
        hasMusic5000: false,
        hasTeletextAdaptor: false,
    };

    it("is not pending when the settings match the running machine", () => {
        expect(restartPending({ ...running }, running)).toBe(false);
    });

    it("is pending when a fitting was added", () => {
        expect(restartPending({ ...running, coProcessor: true }, running)).toBe(true);
    });

    it("stops being pending once the setting is put back", () => {
        const changed = { ...running, hasMusic5000: true };
        expect(restartPending(changed, running)).toBe(true);
        expect(restartPending({ ...changed, hasMusic5000: false }, running)).toBe(false);
    });

    it("ignores settings the running machine can follow", () => {
        expect(restartPending({ ...running, keyLayout: "natural" }, running)).toBe(false);
    });
});

describe("tubeCpuSpeedLabel", () => {
    const bbcB = findModel("B-DFS1.2");
    const master = findModel("Master");

    it("shows each machine's own second processor at 1x", () => {
        expect(tubeCpuSpeedLabel(1, bbcB)).toBe("1x (3MHz)");
        expect(tubeCpuSpeedLabel(1, master)).toBe("1x (4MHz)");
    });

    it("shows a fractional overclock", () => {
        expect(tubeCpuSpeedLabel(1.6, bbcB)).toBe("1.6x (4.8MHz)");
    });

    it("keeps a repeating multiplier from a URL readable", () => {
        expect(tubeCpuSpeedLabel(4 / 3, bbcB)).toBe("1.33x (4MHz)");
    });
});

describe("Config", () => {
    let onChange;
    let onClose;
    let onRestartRequired;
    let config;

    const dialog = () => document.getElementById("configuration");
    const openDialog = () => dialog().dispatchEvent(new Event("show.bs.modal"));
    const closeDialog = () => dialog().dispatchEvent(new Event("hide.bs.modal"));
    const modelDropdownText = () => document.querySelector("#bbc-model-dropdown .bbc-model").textContent;
    const restartPendingShown = () => !document.getElementById("restart-pending").classList.contains("d-none");
    const clickModel = (synonym) => document.querySelector(`.model-menu a[data-target="${synonym}"]`).click();
    const tubeSlider = () => document.getElementById("tubeCpuMultiplier");
    const dragTubeSlider = (value) => {
        tubeSlider().value = value;
        tubeSlider().dispatchEvent(new Event("input"));
    };
    const lastClosedWith = () => onClose.mock.calls.at(-1)[0];

    beforeEach(() => {
        domFromIndexHtml("configuration");
        onChange = vi.fn();
        onClose = vi.fn();
        onRestartRequired = vi.fn();
        config = new Config(onChange, onClose, onRestartRequired);
        // What Settings pushes in after construction, resolved from the URL and storage.
        config.setModel("B-DFS1.2");
        config.setKeyLayout("physical");
        config.setTubeCpuMultiplier(1);
        config.setMicrophoneChannel(undefined);
        config.setCheckboxes({
            coProcessor: false,
            hasEconet: false,
            hasMusic5000: false,
            hasTeletextAdaptor: false,
            mouseJoystickEnabled: false,
            speechOutput: false,
        });
        config.setDisplayMode("rgb");
        config.setAudioOutput("speaker");
        config.setSpeakerAmount(1);
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
            expect(config.model).toBe(findModel("B-DFS1.2"));
            closeDialog();
            expect(config.model).toBe(findModel("Master"));
        });
    });

    describe("opening the dialog", () => {
        it("shows the settings it was handed", () => {
            openDialog();
            expect(modelDropdownText()).toBe(findModel("B-DFS1.2").name);
            expect(document.getElementById("hasMusic5000").checked).toBe(false);
            expect(tubeSlider().disabled).toBe(true);
            expect(restartPendingShown()).toBe(false);
        });

        it("forgets a previous visit's changes", () => {
            openDialog();
            clickModel("Master");
            closeDialog();
            onClose.mockClear();
            openDialog();
            closeDialog();
            expect(onClose).toHaveBeenCalledWith({});
        });
    });

    describe("closing the dialog", () => {
        it("reports an untouched dialog as no changes at all", () => {
            const settingsChanged = vi.fn();
            config.addEventListener("settings-changed", settingsChanged);
            openDialog();
            closeDialog();
            expect(onClose).toHaveBeenCalledWith({});
            expect(settingsChanged).not.toHaveBeenCalled();
            expect(onRestartRequired).not.toHaveBeenCalled();
        });

        it("hands the changes to the close callback and the settings-changed event alike", () => {
            const settingsChanged = vi.fn();
            config.addEventListener("settings-changed", settingsChanged);
            openDialog();
            clickModel("Master");
            document.getElementById("hasMusic5000").click();
            closeDialog();
            expect(onClose).toHaveBeenCalledWith({ model: "Master", hasMusic5000: true });
            expect(settingsChanged.mock.calls[0][0].detail).toEqual({ model: "Master", hasMusic5000: true });
        });
    });

    describe("a change that needs a restart", () => {
        it("warns as soon as the model is picked and asks for the restart on close", () => {
            openDialog();
            expect(restartPendingShown()).toBe(false);
            clickModel("Master");
            expect(restartPendingShown()).toBe(true);
            closeDialog();
            expect(onRestartRequired).toHaveBeenCalledTimes(1);
        });

        it("stops asking once the setting is put back", () => {
            openDialog();
            document.getElementById("hasMusic5000").click();
            closeDialog();
            expect(onRestartRequired).toHaveBeenCalledTimes(1);
            openDialog();
            document.getElementById("hasMusic5000").click();
            expect(restartPendingShown()).toBe(false);
            closeDialog();
            expect(lastClosedWith()).toEqual({ hasMusic5000: false });
            expect(onRestartRequired).toHaveBeenCalledTimes(1);
        });

        it("does not ask when a touched control is back where the machine already is", () => {
            openDialog();
            document.getElementById("hasMusic5000").click();
            document.getElementById("hasMusic5000").click();
            closeDialog();
            expect(lastClosedWith()).toEqual({ hasMusic5000: false });
            expect(onRestartRequired).not.toHaveBeenCalled();
        });
    });

    describe("the co-processor controls", () => {
        it("only lets the tube speed be set while the co-processor is ticked", () => {
            openDialog();
            document.getElementById("65c02").click();
            expect(tubeSlider().disabled).toBe(false);
            document.getElementById("65c02").click();
            expect(tubeSlider().disabled).toBe(true);
        });

        it("labels a dragged tube speed with the machine it will drive", () => {
            openDialog();
            dragTubeSlider(2);
            expect(document.getElementById("tubeCpuMultiplierValue").textContent).toBe("2x (6MHz)");
            closeDialog();
            expect(lastClosedWith()).toEqual({ tubeCpuMultiplier: 2 });
        });

        it("labels the tube speed for a newly picked model's own second processor", () => {
            openDialog();
            clickModel("Master");
            expect(document.getElementById("tubeCpuMultiplierValue").textContent).toBe("1x (4MHz)");
        });
    });

    describe("the dropdown pickers", () => {
        it("saves a keyboard layout and shows it capitalised", () => {
            openDialog();
            document.querySelector('.keyboard-menu a[data-target="natural"]').click();
            expect(document.querySelector(".keyboard-layout").textContent).toBe("Natural");
            closeDialog();
            expect(lastClosedWith()).toEqual({ keyLayout: "natural" });
        });

        it("saves a microphone channel", () => {
            openDialog();
            document.querySelector('.mic-channel-option[data-channel="2"]').click();
            expect(document.querySelector(".mic-channel-text").textContent).toBe("Channel 2");
            closeDialog();
            expect(lastClosedWith()).toEqual({ microphoneChannel: 2 });
        });

        it("saves disabling the microphone as a change, not an omission", () => {
            openDialog();
            document.querySelector('.mic-channel-option[data-channel=""]').click();
            expect(document.querySelector(".mic-channel-text").textContent).toBe("Disabled");
            closeDialog();
            expect(lastClosedWith()).toStrictEqual({ microphoneChannel: undefined });
        });
    });

    describe("the live settings", () => {
        it("applies a sound output at once as well as saving it", () => {
            openDialog();
            document.querySelector('.audio-output-option[data-output="board"]').click();
            expect(onChange).toHaveBeenCalledWith({ audioOutput: "board" });
            closeDialog();
            expect(lastClosedWith()).toEqual({ audioOutput: "board" });
        });

        it("applies a display mode at once and shows its name", () => {
            openDialog();
            document.querySelector('.display-mode-option[data-mode="pal"]').click();
            expect(onChange).toHaveBeenCalledWith({ displayMode: "pal" });
            expect(document.querySelector(".display-mode-text").textContent).toBe("PAL TV");
        });

        it("applies a dragged speaker amount at once", () => {
            const slider = document.getElementById("speakerAmountSetting");
            slider.value = 0.5;
            slider.dispatchEvent(new Event("input"));
            expect(onChange).toHaveBeenCalledWith({ speakerAmount: 0.5 });
        });
    });

    describe("being told the applied settings", () => {
        it("names the model everywhere the page shows it", () => {
            config.setModel("Master");
            expect(document.querySelector(".modal-title .bbc-model").textContent).toBe(findModel("Master").name);
            expect(modelDropdownText()).toBe(findModel("Master").name);
        });

        it("shows a sound output and gates the speaker slider on it", () => {
            config.setAudioOutput("board");
            expect(document.querySelector(".audio-output-text").textContent).toBe("Line out");
            expect(document.getElementById("speakerAmountSetting").disabled).toBe(true);
            config.setAudioOutput("speaker");
            expect(document.getElementById("speakerAmountSetting").disabled).toBe(false);
        });

        it("offers the ROMs for the fittings that are ticked", () => {
            config.setModel("Master");
            config.setCheckboxes({ hasEconet: true, hasMusic5000: true });
            expect(config.extraRoms).toEqual(["master/anfs-4.25.rom", "ample.rom"]);
        });
    });

    describe("mapLegacyModels", () => {
        it("splits the combination models into a model and its fitting", () => {
            const turbo = { model: "MasterTurbo" };
            config.mapLegacyModels(turbo);
            expect(turbo).toEqual({ model: "Master", coProcessor: true });

            const music = { model: "BMusic5000" };
            config.mapLegacyModels(music);
            expect(music).toEqual({ model: "B-DFS1.2", hasMusic5000: true });

            const teletext = { model: "BTeletext" };
            config.mapLegacyModels(teletext);
            expect(teletext).toEqual({ model: "B-DFS1.2", hasTeletextAdaptor: true });
        });

        it("leaves a query with no model alone", () => {
            const query = { autoboot: true };
            config.mapLegacyModels(query);
            expect(query).toEqual({ autoboot: true });
        });
    });
});

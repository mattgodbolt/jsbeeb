// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaWindow, bootDecision, shortName } from "../../src/web/media-window.js";
import { PanelArrangement } from "../../src/web/floating-panel.js";
import { MachineRequirements, describeRef, describeSessionFile } from "../../src/web/media-catalogue.js";
import { MachineSwitch } from "../../src/web/machine-switch.js";
import { MediaSlots } from "../../src/web/media-slots.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
import { DiscLayout } from "../../src/disc.js";
import { toHfe } from "../../src/disc-hfe.js";
import {
    domFromIndexHtml,
    fakeFdc,
    fakeUrlState,
    sentEvents,
    ssdImage,
    stubNavigation,
    teardownDom,
    toasts,
} from "./helpers.js";

/** An SSD whose catalogue carries a title and cycle number. */
function titledImage(title, cycle) {
    const data = ssdImage();
    data.set(new TextEncoder().encode(title.slice(0, 8)), 0);
    data.set(new TextEncoder().encode(title.slice(8, 12)), 0x100);
    data[0x104] = cycle;
    return data;
}

const elite = {
    ref: "hfe:A.hfe",
    kind: "disc",
    title: "Elite",
    publisher: "Acornsoft",
    detail: "D1S1 · 40 · v1",
    source: "hfe",
    savesChanges: false,
};
const chuckie = {
    ref: "sth:AnF/Chuckie.zip",
    kind: "tape",
    title: "Chuckie",
    publisher: "AnF",
    detail: "",
    source: "sth",
    savesChanges: false,
};
const saves = { ...elite, ref: "local:saves.ssd", title: "saves.ssd", source: "browser", savesChanges: true };
const driveMine = { ...elite, ref: "gd:abc/mine.ssd", title: "mine.ssd", source: "gdrive" };
const sessionMine = { ...elite, ref: "session:mine.ssd", title: "mine.ssd", source: "session" };

describe("MediaWindow", () => {
    let deps;
    let fdc;
    let tapeInterface;
    let loop;
    let urlState;
    let confirm;

    beforeEach(() => {
        domFromIndexHtml("navbarSupportedContent", "leds", "drop-zone", "media-panel", "drive-bay-template");
        document.querySelector(".media-header").setPointerCapture = () => {};
        fdc = fakeFdc();
        tapeInterface = {
            tape: undefined,
            motorOn: false,
            playPressed: true,
            get tapeRunning() {
                return this.motorOn && this.playPressed;
            },
            rewindTape: vi.fn(),
            pressPlay: vi.fn(() => (tapeInterface.playPressed = true)),
            pressStop: vi.fn(() => (tapeInterface.playPressed = false)),
        };
        tapeInterface.setTape = (tape) => (tapeInterface.tape = tape);
        loop = new EventTarget();
        urlState = fakeUrlState();
        const drives = new Drives({
            fdc,
            hasDiscDrives: true,
            driveTracks: [DriveTracks.auto, DriveTracks.auto],
            confirm: vi.fn(),
            urlState,
        });
        const processor = { fdc, tapeInterface, hasTube: false, reset: vi.fn() };
        const media = new EventTarget();
        Object.assign(media, {
            params: urlState.params,
            listAll: vi.fn().mockResolvedValue({ descriptors: [], failures: [] }),
            loadDiscImage: vi.fn(),
            loadTapeImage: vi.fn(),
            openFile: vi.fn(),
            setAutoboot: vi.fn((on) => urlState.set({ autoboot: on ? true : undefined })),
        });
        media.slots = new MediaSlots({ loader: media, drives, processor, urlState });
        const model = { isAtom: false, hasDiscDrives: true };
        confirm = vi.fn();
        deps = {
            media,
            drives,
            processor,
            model,
            loop,
            visualiser: { openOn: vi.fn(), openReport: vi.fn(), redraw: vi.fn() },
            arrangement: new PanelArrangement(() => window.localStorage),
            autoboot: vi.fn(),
            driveSource: {
                connect: vi.fn().mockResolvedValue(true),
                connected: false,
                createBlank: vi.fn(),
                createFrom: vi.fn(),
            },
            machineSwitch: new MachineSwitch({ model, processor, urlState, modals: { confirm } }),
        };
    });

    let made;
    afterEach(() => {
        made?.dispose();
        made = null;
        return teardownDom();
    });

    const byId = (id) => document.getElementById(id);
    const make = () => (made = new MediaWindow(deps));
    const panel = () => byId("media-panel");
    const bay = (driveIndex) => document.querySelector(`.bay[data-drive="${driveIndex}"]`);
    const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
    const readoutLine = (slot) => document.querySelector(`#leds .slot-readout[data-slot="${slot}"]`);
    const readout = (slot) => text(readoutLine(slot).querySelector(".line"));
    const slots = () => deps.media.slots;
    const quietErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});
    const ssd = (name = "A.ssd") => discFor(name, ssdImage());
    /** What the URL naming a Drive disc leaves behind at startup, before Drive is connected. */
    const failedStartupLoad = async (ref) => {
        quietErrors();
        deps.media.loadDiscImage.mockRejectedValueOnce(new Error("Google Drive is not connected"));
        await slots().load(slots().drive(0), describeRef(ref, "disc"));
    };
    const putDiscIn = (driveIndex, disc, ref) => slots().put(slots().drive(driveIndex), disc, ref);
    const putTapeIn = (tape, ref) => slots().put(slots().deck, tape, ref);
    const tick = () => loop.dispatchEvent(new Event("tick"));
    const hint = () => [...document.querySelectorAll("#media-hint > span")].map(text);
    const autobootTick = () => document.querySelector("#media-panel .autoboot");
    const setTick = (checked) => {
        autobootTick().checked = checked;
        autobootTick().dispatchEvent(new Event("change"));
    };
    const press = (key, target = document.activeElement, shiftKey = false) =>
        target.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
    const pressEnter = (shiftKey = false) => press("Enter", byId("media-search"), shiftKey);
    const aim = (target) => document.querySelector(`#media-into [data-target="${target}"]`).click();
    const rows = () => [...document.querySelectorAll("#media-list .media-row")];
    const rowTitles = () => rows().map((row) => text(row.querySelector(".title")));
    const rowMain = (index = 0) => rows()[index].querySelector(".media-row-main");
    const rowFor = (title) => rows().find((row) => row.textContent.includes(title));
    const shiftClick = (el) => el.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
    const search = (query) => {
        const box = byId("media-search");
        box.value = query;
        box.dispatchEvent(new Event("input"));
    };
    const fileNamed = (name) => new File([new Uint8Array(4)], name);
    const pickFile = (name) => {
        const input = byId("media-open");
        Object.defineProperty(input, "files", { value: [fileNamed(name)] });
        input.dispatchEvent(new Event("change"));
    };
    const dragCarrying =
        (types) =>
        (type, target = document.body) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { types, files: [], dropEffect: "" } });
            target.dispatchEvent(event);
            return event;
        };
    const dragEvent = dragCarrying(["Files"]);
    const dropFile = (name) => {
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [fileNamed(name)] } });
        document.body.dispatchEvent(event);
    };
    const submitDiscForm = (name, where) => {
        byId("media-new-disc-name").value = name;
        if (where) document.querySelector(`#media-new-disc-where input[value="${where}"]`).checked = true;
        byId("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
    };
    const makeNewDisc = (name, where) => {
        byId("media-new-disc").click();
        submitDiscForm(name, where);
    };
    /** Opens the window over a list of `descriptors`, and waits for it to have drawn them. */
    const openWith = async (descriptors = [], failures = []) => {
        deps.media.listAll.mockResolvedValue({ descriptors, failures });
        const window = make();
        window.open();
        await vi.waitFor(() => expect(byId("media-count").textContent).not.toBe(""));
        return window;
    };

    describe("opening, closing and aiming", () => {
        it("opens from the menu items and the LED panel readouts, and closes from its button", () => {
            const window = make();
            expect(panel().hidden).toBe(true);
            byId("navbarMedia").click();
            expect(window.isOpen).toBe(true);
            expect(document.activeElement).toBe(byId("media-search"));
            byId("media-close").click();
            expect(window.isOpen).toBe(false);
            readoutLine("tape").click();
            expect(panel().hidden).toBe(false);
        });

        const deckFolded = () => panel().classList.contains("deck-collapsed");
        const bayFolded = () => bay(1).classList.contains("folded");
        const fromOpenWindow = (act) => () => {
            made.open();
            document.activeElement.blur();
            act();
        };
        it.each([
            ["drive 1's line in the LED panel", () => readoutLine("1").click(), () => bay(1), bayFolded],
            [
                "the tape's line in the LED panel",
                () => readoutLine("tape").click(),
                () => byId("deck-window"),
                deckFolded,
            ],
            [
                "drive 1's slot",
                fromOpenWindow(() => bay(1).querySelector(".bay-slot").click()),
                () => bay(1),
                bayFolded,
            ],
            [
                "the deck's window",
                fromOpenWindow(() => byId("deck-window").click()),
                () => byId("deck-window"),
                deckFolded,
            ],
            ["the Into control at drive 1", fromOpenWindow(() => aim("1")), () => bay(1), bayFolded],
            ["the Into control at the deck", fromOpenWindow(() => aim("tape")), () => byId("deck-window"), deckFolded],
        ])("aims the list from %s, unfolding the target, ready to type into", (_, act, target, folded) => {
            make();
            act();
            expect([...document.querySelectorAll("#media-panel .target")]).toEqual([target()]);
            expect(folded()).toBe(false);
            expect(document.activeElement).toBe(byId("media-search"));
        });

        it("aims at drive 0 again whenever the Media button opens it", () => {
            make();
            readoutLine("1").click();
            byId("navbarMedia").click();
            expect([...document.querySelectorAll("#media-panel .target")]).toEqual([bay(0)]);
        });
    });

    describe("a drive bay", () => {
        it("starts empty, with the latch open and nothing to save or eject", () => {
            make();
            expect(bay(0).dataset.state).toBe("empty");
            expect(bay(0).querySelector(".bay-save").disabled).toBe(true);
            expect(bay(0).querySelector(".bay-surface").disabled).toBe(true);
            expect(text(bay(0).querySelector(".bay-status"))).toBe("nothing loaded · reads 80 track discs");
            expect(readout("0")).toBe("empty");
        });

        it("shows the disc put in it: its name, the sticker, the pitch and where it came from", () => {
            make();
            putDiscIn(1, discFor("ELITE.ssd", titledImage("ELITE", 0x04)), "sth:Games/ELITE.zip");
            expect(bay(1).dataset.state).toBe("loaded");
            expect(text(bay(1).querySelector(".bay-title"))).toBe("ELITE.ssd");
            expect(text(bay(1).querySelector(".bay-dfs"))).toBe("ELITE (04)");
            expect(text(bay(1).querySelector(".bay-sub"))).toBe("80 track · 1 side · STH archive");
            expect(text(bay(1).querySelector(".bay-status"))).toBe("80T · 1 side · STH archive");
            expect(text(bay(1).querySelector(".bay-kept"))).toBe("· changes are not being kept");
            expect(bay(1).querySelector(".bay-kept").classList.contains("warn")).toBe(true);
            expect(bay(1).querySelector(".bay-eject").disabled).toBe(false);
            expect(bay(1).querySelector('input[value="80"]').checked).toBe(true);
            expect(readout("1")).toBe("ELITE");
            expect(text(byId("media-summary"))).toBe("0: empty · 1: ELITE.ssd · tape: empty");
        });

        it("notes what loading the disc found out, picking out the oddities", () => {
            make();
            const loaded = discFor("odd.ssd", titledImage("ODD", 1));
            loaded.loadNotes = [
                { text: "40 track, as its catalogue says so", isOdd: false },
                { text: "a bit rate far from 250 kbit/s on track 3", isOdd: true },
            ];
            putDiscIn(0, loaded);
            const notes = bay(0).querySelector(".bay-notes");
            expect(text(notes)).toBe("40 track, as its catalogue says so · a bit rate far from 250 kbit/s on track 3");
            expect([...notes.querySelectorAll(".warn")].map(text)).toEqual([
                "a bit rate far from 250 kbit/s on track 3",
            ]);
            expect(notes.title).toBe("40 track, as its catalogue says so\na bit rate far from 250 kbit/s on track 3");
            putDiscIn(0, discFor("plain.ssd", titledImage("PLAIN", 1), undefined, DiscLayout.contiguous));
            expect(notes.hidden).toBe(true);
        });

        it("follows the catalogue as it is written, and stops following a disc once it is out", () => {
            make();
            const first = discFor("a.ssd", titledImage("ELITE", 5));
            putDiscIn(0, first);
            expect(bay(0).querySelector(".bay-dfs").hidden).toBe(false);
            first.eraseTrack(false, 0);
            expect(bay(0).querySelector(".bay-dfs").hidden).toBe(true);
            putDiscIn(0, discFor("b.ssd", titledImage("ZALAGA", 1)));
            expect(text(bay(0).querySelector(".bay-dfs"))).toBe("ZALAGA (01)");
            first.eraseTrack(false, 0);
            expect(text(bay(0).querySelector(".bay-dfs"))).toBe("ZALAGA (01)");
        });

        it("hides the sticker when the catalogue is blank", () => {
            make();
            putDiscIn(0, ssd("blank.ssd"));
            expect(bay(0).querySelector(".bay-dfs").hidden).toBe(true);
        });

        it("follows a 40 track disc onto the switch, and moves the switch from the radios", () => {
            make();
            putDiscIn(0, discFor("forty.ssd", ssdImage(400)));
            expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);
            const eighty = bay(0).querySelector('input[value="80"]');
            eighty.checked = true;
            eighty.dispatchEvent(new Event("change"));
            expect(fdc.drives[0].tracksPerStep).toBe(1);
            expect(text(bay(0).querySelector(".bay-status"))).toContain("80T");
        });

        it("throws the switch the other way when its track is clicked", () => {
            make();
            putDiscIn(0, ssd());
            bay(0).querySelector(".pitch .track").click();
            expect(fdc.drives[0].tracksPerStep).toBe(2);
            expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);
            bay(0).querySelector(".pitch .track").click();
            expect(fdc.drives[0].tracksPerStep).toBe(1);
        });

        it("ejects from the latch", () => {
            make();
            putDiscIn(0, ssd("a.ssd"));
            expect(text(bay(0).querySelector(".bay-title"))).toBe("a.ssd");
            bay(0).querySelector(".bay-eject").click();
            expect(fdc.drives[0].disc).toBeUndefined();
            expect(bay(0).dataset.state).toBe("empty");
            expect(readout("0")).toBe("empty");
            expect(text(bay(0).querySelector(".bay-title"))).toBe("");
            expect(text(bay(0).querySelector(".bay-sub"))).toBe("");
        });

        it("saves through the drives and opens the surface, or its report, on its own drive", () => {
            make();
            putDiscIn(1, ssd());
            const ssdSave = vi.spyOn(deps.drives, "downloadSsdOrDsd").mockResolvedValue();
            const hfeSave = vi.spyOn(deps.drives, "downloadHfe").mockImplementation(() => {});
            bay(1).querySelector(".bay-save-ssd").click();
            bay(1).querySelector(".bay-save-hfe").click();
            bay(1).querySelector(".bay-surface").click();
            bay(1).querySelector(".bay-report").click();
            expect(ssdSave).toHaveBeenCalledWith(1);
            expect(hfeSave).toHaveBeenCalledWith(1);
            expect(deps.visualiser.openOn).toHaveBeenCalledWith(1);
            expect(deps.visualiser.openReport).toHaveBeenCalledWith(1);
        });

        it("nudges the search box when a slot asks for something to load", () => {
            vi.useFakeTimers();
            make();
            const box = byId("media-search");
            bay(1).querySelector(".bay-slot").click();
            expect(box.classList.contains("attention")).toBe(true);
            vi.runAllTimers();
            expect(box.classList.contains("attention")).toBe(false);
        });

        it("selects what was in the search box when aimed, so typing replaces it", () => {
            make();
            const box = byId("media-search");
            box.value = "old";
            bay(1).querySelector(".bay-slot").click();
            expect(box.selectionStart).toBe(0);
            expect(box.selectionEnd).toBe(3);
        });

        it("lights while the controller selects the drive, only while open", () => {
            const window = make();
            fdc.motorOn[0] = true;
            tick();
            expect(bay(0).querySelector(".bay-led").classList.contains("on")).toBe(false);
            window.open();
            tick();
            expect(bay(0).querySelector(".bay-led").classList.contains("on")).toBe(true);
            expect(bay(1).querySelector(".bay-led").classList.contains("on")).toBe(false);
        });
    });

    describe("the deck", () => {
        const tape = (position = 0) => ({ name: "chuckie.uef", position });
        const counter = () => text(byId("tape-counter"));
        const readoutCounter = () => text(document.querySelector('#leds [data-slot="tape"] .counter'));
        const status = () => text(byId("deck-status"));
        const motorShown = () => byId("media-deck").classList.contains("motor");

        it("starts empty with every key up and disabled", () => {
            make();
            expect(byId("deck-empty").hidden).toBe(false);
            for (const id of ["tape-rewind", "tape-play", "tape-stop", "tape-eject"])
                expect(byId(id).disabled).toBe(true);
            expect(readout("tape")).toBe("empty");
        });

        it("shows the tape and its counter, and where it came from", () => {
            make();
            putTapeIn(tape(0.5), "sth:Games/Chuckie.zip");
            expect(byId("deck-cassette").hidden).toBe(false);
            expect(text(byId("deck-tape-title"))).toBe("chuckie.uef");
            expect(status()).toBe("chuckie.uef · STH archive · motor off");
            expect(counter()).toBe("499");
            expect(readout("tape")).toBe("chuckie499");
            expect(readoutCounter()).toBe("499");
        });

        it("counts from wherever the counter was reset", () => {
            make();
            putTapeIn(tape(0.5));
            byId("tape-counter-reset").click();
            expect(counter()).toBe("000");
            tapeInterface.tape.position = 0.51;
            tick();
            expect(counter()).toBe("010");
        });

        it("runs the reels and the data light while the motor is on", () => {
            make();
            putTapeIn(tape());
            tapeInterface.motorOn = true;
            tick();
            expect(motorShown()).toBe(true);
            expect(byId("deck-data").classList.contains("on")).toBe(true);
            expect(byId("tape-play").getAttribute("aria-pressed")).toBe("true");
            tapeInterface.motorOn = false;
            tick();
            expect(motorShown()).toBe(false);
        });

        it("works PLAY and STOP as a latch on a BBC, which the motor relay runs against", () => {
            make();
            putTapeIn(tape());
            expect(byId("tape-play").disabled).toBe(true);
            expect(byId("tape-play").getAttribute("aria-pressed")).toBe("true");
            expect(byId("tape-stop").disabled).toBe(false);
            tapeInterface.motorOn = true;
            tick();
            expect(motorShown()).toBe(true);
            expect(status()).toContain("playing");
            byId("tape-stop").click();
            expect(tapeInterface.pressStop).toHaveBeenCalled();
            expect(byId("tape-play").disabled).toBe(false);
            expect(byId("tape-stop").disabled).toBe(true);
            tick();
            expect(motorShown()).toBe(false);
            expect(status()).toContain("stopped");
            byId("tape-play").click();
            expect(tapeInterface.pressPlay).toHaveBeenCalled();
            tick();
            tapeInterface.motorOn = false;
            tick();
            expect(status()).toContain("motor off");
        });

        it("works PLAY and STOP as the motor itself on an Atom, with nothing to say about a relay", () => {
            deps.model.isAtom = true;
            tapeInterface.playPressed = false;
            make();
            putTapeIn(tape());
            expect(status()).toContain("stopped");
            byId("tape-play").click();
            expect(tapeInterface.pressPlay).toHaveBeenCalled();
            tapeInterface.motorOn = true;
            tick();
            expect(byId("tape-play").disabled).toBe(true);
            expect(status()).toContain("playing");
            byId("tape-stop").click();
            expect(tapeInterface.pressStop).toHaveBeenCalled();
            tapeInterface.motorOn = false;
            tick();
            expect(status()).not.toContain("motor off");
        });

        it("starts a new tape's counter from zero, whatever the last one was reset to", () => {
            make();
            putTapeIn(tape(0.5));
            byId("tape-counter-reset").click();
            expect(counter()).toBe("000");
            slots().eject(slots().deck);
            putTapeIn(tape(0));
            expect(counter()).toBe("000");
        });

        it("blanks the readout's counter when the tape is ejected, and the deck's counter reads zero", () => {
            make();
            putTapeIn(tape(0.5));
            expect(readoutCounter()).toBe("499");
            slots().eject(slots().deck);
            expect(readoutCounter()).toBe("");
            expect(counter()).toBe("000");
            putTapeIn(tape(0.5));
            expect(readoutCounter()).toBe("499");
        });

        it("rewinds and ejects from the keys", () => {
            make();
            putTapeIn(tape());
            byId("tape-rewind").click();
            expect(tapeInterface.rewindTape).toHaveBeenCalled();
            byId("tape-eject").click();
            expect(tapeInterface.tape).toBeUndefined();
            expect(byId("deck-empty").hidden).toBe(false);
        });

        it("starts folded on a BBC, unfolds when a tape goes in, and folds and unfolds on a click", () => {
            make();
            expect(panel().classList.contains("deck-collapsed")).toBe(true);
            expect(text(byId("deck-bar-name"))).toBe("empty");
            putTapeIn(tape());
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
            byId("deck-hide").click();
            expect(panel().classList.contains("deck-collapsed")).toBe(true);
            expect(text(byId("deck-bar-name"))).toBe("chuckie.uef");
            byId("deck-toggle").click();
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
        });

        it("cannot be folded while a tape is in it", () => {
            make();
            putTapeIn(tape());
            expect(byId("deck-hide").hidden).toBe(true);
            slots().eject(slots().deck);
            expect(byId("deck-hide").hidden).toBe(false);
        });
    });

    describe("folding", () => {
        it("starts with drive 1 folded to a line, which unfolds it when clicked", () => {
            make();
            expect(bay(1).classList.contains("folded")).toBe(true);
            expect(text(bay(1).querySelector(".bay-bar-name"))).toBe("empty");
            bay(1).querySelector(".bay-bar").click();
            expect(bay(1).classList.contains("folded")).toBe(false);
        });

        it("unfolds drive 1 when a disc goes into it, however it got there", () => {
            make();
            putDiscIn(1, ssd("b.ssd"));
            expect(bay(1).classList.contains("folded")).toBe(false);
            expect(text(bay(1).querySelector(".bay-bar-name"))).toBe("b.ssd");
        });

        it("has the disc surface drawn again for a disc put in, which a paused machine would not prompt, but not for a tape", () => {
            make();
            putTapeIn({ name: "chuckie.uef", position: 0 });
            expect(deps.visualiser.redraw).not.toHaveBeenCalled();
            putDiscIn(1, ssd("b.ssd"));
            expect(deps.visualiser.redraw).toHaveBeenCalledTimes(1);
        });

        it("opens with the list whichever way it is opened, and the list folds and unfolds on request", () => {
            putDiscIn(0, ssd());
            const window = make();
            readoutLine("0").click();
            expect(window.isOpen).toBe(true);
            expect(panel().classList.contains("list-collapsed")).toBe(false);
            expect(document.activeElement).toBe(byId("media-search"));
            byId("list-hide").click();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            byId("list-toggle").click();
            expect(panel().classList.contains("list-collapsed")).toBe(false);
        });

        it("lets drive 1 fold away again once it is empty, but not while it holds a disc", () => {
            make();
            bay(1).querySelector(".bay-bar").click();
            expect(bay(1).querySelector(".bay-hide").hidden).toBe(false);
            bay(1).querySelector(".bay-hide").click();
            expect(bay(1).classList.contains("folded")).toBe(true);
            putDiscIn(1, ssd("b.ssd"));
            expect(bay(1).classList.contains("folded")).toBe(false);
            expect(bay(1).querySelector(".bay-hide").hidden).toBe(true);
            expect(bay(0).querySelector(".bay-hide").hidden).toBe(true);
        });

        it("lets the latch of an empty drive aim the list at it, unfolding the list", () => {
            putDiscIn(0, ssd());
            make();
            readoutLine("0").click();
            byId("list-hide").click();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            bay(0).querySelector(".bay-eject").click();
            expect(fdc.drives[0].disc).toBeUndefined();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            bay(0).querySelector(".bay-eject").click();
            expect(panel().classList.contains("list-collapsed")).toBe(false);
            expect(bay(0).classList.contains("target")).toBe(true);
            expect(document.activeElement).toBe(byId("media-search"));
        });
    });

    describe("the list", () => {
        it("lists the discs every source offers once opened, with the search box focused and a chip per source", async () => {
            await openWith([elite, chuckie, saves]);
            expect(document.activeElement).toBe(byId("media-search"));
            expect(rowTitles()).toEqual(["Elite", "saves.ssd"]);
            expect(text(byId("media-count"))).toBe("2 of 3");
            const chips = [...document.querySelectorAll("#media-chips .media-chip")].map((c) => c.textContent);
            expect(chips).toEqual(["All", "STH archive 1", "HFE archive 1", "This browser 1", "Discs", "Tapes"]);
            expect(text(rows()[1].querySelector(".detail"))).toContain("saves changes");
        });

        it("shows tapes when aimed at the deck, and either when the chips say so", async () => {
            await openWith([elite, chuckie, saves]);
            byId("deck-window").click();
            expect(rowTitles()).toEqual(["Chuckie"]);
            document.querySelector('#media-chips .media-chip[title="Show discs"]').click();
            expect(rowTitles()).toEqual(["Chuckie", "Elite", "saves.ssd"]);
        });

        it("narrows to what is typed and to a source, best match first", async () => {
            const cheat = {
                ...elite,
                ref: "sth:Cheats/CHT_Elite-Editor.zip",
                title: "CHT_Elite-Editor",
                source: "sth",
            };
            await openWith([cheat, elite, saves]);
            search("elit");
            expect(rowTitles()).toEqual(["Elite", "CHT_Elite-Editor"]);
            search("");
            document.querySelector('#media-chips .media-chip[title="The Stairway To Hell mirror"]').click();
            expect(rowTitles()).toEqual(["CHT_Elite-Editor"]);
            document.querySelector("#media-chips .media-chip").click();
            search("nothing here");
            expect(rowTitles()).toEqual([]);
            expect(text(document.querySelector("#media-list .notice"))).toBe('Nothing matches "nothing here"');
        });

        it("loads the first match on Enter in the search box, and walks the rows with the arrows", async () => {
            deps.media.loadDiscImage.mockResolvedValue(ssd());
            await openWith([elite, saves]);
            const box = byId("media-search");
            press("ArrowDown", box);
            expect(document.activeElement).toBe(rowMain(0));
            press("ArrowDown");
            expect(document.activeElement).toBe(rowMain(1));
            press("ArrowUp");
            press("ArrowUp");
            expect(document.activeElement).toBe(box);
            pressEnter();
            await vi.waitFor(() => expect(fdc.drives[0].disc).toBeTruthy());
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("hfe:A.hfe", "auto");
        });

        it("puts what was loaded most recently first, under a heading, until something is typed", async () => {
            const zalaga = { ...elite, ref: "hfe:Z.hfe", title: "Zalaga" };
            const headings = () => [...document.querySelectorAll("#media-list .media-heading")].map(text);
            putDiscIn(1, ssd("Z.ssd"), zalaga.ref);
            putTapeIn({ name: "chuckie.uef" }, chuckie.ref);
            putDiscIn(1, ssd("saves.ssd"), saves.ref);
            deps.media.loadDiscImage.mockResolvedValue(ssd("saves.ssd"));
            await openWith([elite, chuckie, saves, zalaga]);
            expect(rowTitles()).toEqual(["saves.ssd", "Zalaga", "Elite"]);
            expect(headings()).toEqual(["Recently loaded", "Everything else"]);
            for (const heading of document.querySelectorAll("#media-list .media-heading"))
                expect(heading.getAttribute("aria-hidden")).toBe("true");
            expect(rowMain(1).getAttribute("aria-label")).toBe(
                "Boot Zalaga, Acornsoft, D1S1 · 40 · v1, HFE archive from drive 0, recently loaded",
            );
            expect(rowMain(1).title).toBe("Boot Zalaga, Acornsoft, D1S1 · 40 · v1, HFE archive from drive 0");
            expect(rowMain(2).getAttribute("aria-label")).not.toContain("recently loaded");
            byId("media-search").focus();
            press("ArrowDown");
            expect(document.activeElement).toBe(rowMain(0));
            press("ArrowDown");
            press("ArrowDown");
            expect(text(document.activeElement.querySelector(".title"))).toBe("Elite");
            press("ArrowUp");
            expect(text(document.activeElement.querySelector(".title"))).toBe("Zalaga");
            search("s");
            expect(rowTitles()).toEqual(["saves.ssd", "Elite", "Zalaga"]);
            expect(headings()).toEqual([]);
            search("");
            pressEnter();
            await vi.waitFor(() => expect(deps.media.loadDiscImage).toHaveBeenCalledWith("local:saves.ssd", "auto"));
        });

        it("has no heading when nothing shown was loaded recently", async () => {
            putTapeIn({ name: "chuckie.uef" }, chuckie.ref);
            await openWith([elite, chuckie, saves]);
            expect(rowTitles()).toEqual(["Elite", "saves.ssd"]);
            expect(document.querySelector("#media-list .media-heading")).toBeNull();
        });

        it("falls back to every source when the chosen one is no longer listed", async () => {
            await openWith([elite, saves]);
            document.querySelector('#media-chips .media-chip[title^="Discs kept in this browser"]').click();
            expect(rowTitles()).toEqual(["saves.ssd"]);
            deps.media.listAll.mockResolvedValue({ descriptors: [elite], failures: [] });
            byId("media-connect-drive").click();
            await vi.waitFor(() => expect(rowTitles()).toEqual(["Elite"]));
            expect(document.querySelector("#media-chips .media-chip").getAttribute("aria-pressed")).toBe("true");
        });

        it("links a row to the page about it only when its source names a web page", async () => {
            const linked = (title, url) => ({
                ...elite,
                ref: `bitshifters:${title}.ssd`,
                title,
                source: "bitshifters",
                url,
            });
            const paradroidUrl = "https://bitshifters.github.io/posts/prods/bs-paradroid.html";
            // Rows come sorted by title.
            await openWith([
                linked("a script", "javascript:alert(1)"),
                linked("b data", "data:text/html,hi"),
                linked("c junk", "not a url"),
                linked("d plain", "http://example.com/page"),
                elite,
                linked("Paradroid", paradroidUrl),
            ]);
            const links = rows().map((row) => row.querySelector(".media-about"));
            expect(links.map((link) => link?.href ?? null)).toEqual([
                null,
                null,
                null,
                "http://example.com/page",
                null,
                paradroidUrl,
            ]);
            expect(links[5].target).toBe("_blank");
            expect(links[5].title).toBe("About Paradroid at bitshifters.github.io");
        });

        it("says which sources could not be listed", async () => {
            await openWith([elite], ["sth: offline"]);
            expect(text(document.querySelector("#media-list .notice"))).toBe("Could not list sth: offline");
        });

        it("loads a disc into the aimed drive from the row, and the other drive from its button", async () => {
            const loaded = ssd();
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await openWith([elite]);
            const otherButton = () => rows()[0].querySelector(".media-target");
            expect(rowMain().title).toMatch(/^Boot Elite.*from drive 0$/);
            expect(otherButton().title).toBe("Load Elite into drive 1");
            expect(bay(1).classList.contains("folded")).toBe(true);
            otherButton().click();
            expect(bay(1).classList.contains("folded")).toBe(false);
            await vi.waitFor(() => expect(fdc.drives[1].disc === loaded).toBe(true));
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("hfe:A.hfe", "auto");
            expect(urlState.params.disc2).toBe("hfe:A.hfe");
            expect(deps.processor.reset).not.toHaveBeenCalled();
            expect(panel().hidden).toBe(true);
            await vi.waitFor(() => expect(text(rows()[0].querySelector(".detail"))).toContain("in drive 1"));
            bay(1).querySelector(".bay-slot").click();
            expect(text(byId("media-open-text"))).toBe("Open a file into drive 1…");
            expect(rows()[0].querySelector(".media-keycap").textContent).toBe("1");
            expect(otherButton().textContent).toBe("0");
            expect(rowMain().title).toMatch(/^Load Elite.*into drive 1$/);
            expect(otherButton().title).toBe("Boot Elite from drive 0");
        });

        it("is aimed from the Into control, which says where the list points", async () => {
            await openWith([elite]);
            const into = (target) => document.querySelector(`#media-into [data-target="${target}"]`);
            expect(into("0").getAttribute("aria-pressed")).toBe("true");
            aim("1");
            expect(into("1").getAttribute("aria-pressed")).toBe("true");
            expect(into("0").getAttribute("aria-pressed")).toBe("false");
            expect(byId("media-search").placeholder).toBe("Search for a disc for drive 1");
            expect(hint()).toEqual(["Enter loads into drive 1, which does not boot", "Esc closes"]);
            aim("tape");
            expect(byId("media-search").placeholder).toBe("Search for a tape for the deck");
            expect(hint()).toEqual(["Enter loads into the deck", "Esc closes"]);
        });

        it.each([
            [true, ["Enter boots from drive 0", "Shift+Enter loads without booting", "Esc closes"], /^Boot Elite/],
            [
                false,
                ["Enter loads into drive 0", "Shift+Enter loads and boots", "Esc closes"],
                /^Load Elite.*into drive 0$/,
            ],
        ])("says what Enter and a click do once Autoboot is set to %s", async (ticked, keys, title) => {
            await openWith([elite]);
            setTick(ticked);
            expect(hint()).toEqual(keys);
            expect(rowMain().title).toMatch(title);
        });

        describe("what a load into a drive does", () => {
            it.each`
                driveIndex | ticked   | shift    | boot         | inUrl    | boots    | urlAutoboot
                ${0}       | ${true}  | ${false} | ${undefined} | ${true}  | ${true}  | ${true}
                ${0}       | ${true}  | ${true}  | ${undefined} | ${true}  | ${false} | ${false}
                ${0}       | ${false} | ${false} | ${undefined} | ${true}  | ${false} | ${false}
                ${0}       | ${false} | ${true}  | ${undefined} | ${true}  | ${true}  | ${true}
                ${0}       | ${true}  | ${false} | ${undefined} | ${false} | ${true}  | ${false}
                ${0}       | ${true}  | ${false} | ${false}     | ${true}  | ${false} | ${false}
                ${0}       | ${false} | ${false} | ${true}      | ${true}  | ${true}  | ${true}
                ${0}       | ${true}  | ${true}  | ${true}      | ${true}  | ${true}  | ${true}
                ${1}       | ${true}  | ${false} | ${undefined} | ${true}  | ${false} | ${undefined}
                ${1}       | ${false} | ${true}  | ${undefined} | ${true}  | ${false} | ${undefined}
                ${1}       | ${true}  | ${false} | ${true}      | ${true}  | ${false} | ${undefined}
            `(
                "drive $driveIndex, ticked $ticked, Shift $shift, boot $boot, in URL $inUrl: boots $boots, URL autoboot $urlAutoboot",
                ({ driveIndex, ticked, shift, boot, inUrl, boots, urlAutoboot }) => {
                    expect(bootDecision({ driveIndex, ticked, shift, boot, inUrl })).toEqual({ boots, urlAutoboot });
                },
            );

            const otherButton = () => rows()[0].querySelector(".media-target");
            it.each`
                gesture                                | aimed | act                                | drive | boots    | url
                ${"Enter"}                             | ${0}  | ${() => pressEnter()}              | ${0}  | ${true}  | ${true}
                ${"Shift+Enter"}                       | ${0}  | ${() => pressEnter(true)}          | ${0}  | ${false} | ${undefined}
                ${"a click on the row"}                | ${0}  | ${() => rowMain().click()}         | ${0}  | ${true}  | ${true}
                ${"a shift-click on the row"}          | ${0}  | ${() => shiftClick(rowMain())}     | ${0}  | ${false} | ${undefined}
                ${"Enter aimed at drive 1"}            | ${1}  | ${() => pressEnter()}              | ${1}  | ${false} | ${true}
                ${"a click on drive 0's button"}       | ${1}  | ${() => otherButton().click()}     | ${0}  | ${true}  | ${true}
                ${"a shift-click on drive 0's button"} | ${1}  | ${() => shiftClick(otherButton())} | ${0}  | ${false} | ${undefined}
                ${"a click on drive 1's button"}       | ${0}  | ${() => otherButton().click()}     | ${1}  | ${false} | ${true}
            `("loads into drive $drive on $gesture, booting $boots", async ({ aimed, act, drive, boots, url }) => {
                deps.media.loadDiscImage.mockResolvedValue(ssd());
                urlState.set({ autoboot: true });
                await openWith([elite]);
                aim(aimed);
                act();
                await vi.waitFor(() => expect(made.isOpen).toBe(false));
                expect(fdc.drives[drive].disc).toBeTruthy();
                expect(fdc.drives[1 - drive].disc).toBeUndefined();
                expect(deps.processor.reset).toHaveBeenCalledTimes(boots ? 1 : 0);
                expect(deps.autoboot).toHaveBeenCalledTimes(boots ? 1 : 0);
                expect(urlState.params.autoboot).toBe(url);
            });

            it("notes a boot from the window", async () => {
                const sent = sentEvents();
                deps.media.loadDiscImage.mockResolvedValue(ssd());
                await openWith([elite]);
                rowMain().click();
                await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalled());
                expect(sent("feature_used")).toEqual([
                    { feature: "media_window", action: "open" },
                    { feature: "media_window", action: "boot" },
                ]);
                expect(sent("media_load")).toEqual([expect.objectContaining({ entry: "list", slot: "drive0" })]);
            });

            it("leaves the URL alone when a load fails", async () => {
                quietErrors();
                deps.media.loadDiscImage.mockRejectedValue(new Error("HTTP 404"));
                await openWith([elite]);
                rowMain().click();
                await vi.waitFor(() => expect(bay(0).querySelector(".bay-retry").hidden).toBe(false));
                expect(deps.media.setAutoboot).not.toHaveBeenCalled();
                expect(deps.processor.reset).not.toHaveBeenCalled();
            });

            it("boots a file opened this session, leaving autoboot out of a URL that cannot name it", async () => {
                deps.media.loadDiscImage.mockResolvedValue(ssd("mine.ssd"));
                urlState.set({ autoboot: true });
                await openWith([sessionMine]);
                rowMain().click();
                await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalled());
                expect(urlState.params.autoboot).toBeUndefined();
            });

            it("never boots a tape", async () => {
                deps.media.loadTapeImage.mockResolvedValue({ name: "Chuckie.uef", position: 0 });
                await openWith([chuckie]);
                aim("tape");
                expect(rowMain().title).toMatch(/^Load Chuckie.*into the cassette deck$/);
                pressEnter();
                await vi.waitFor(() => expect(tapeInterface.tape).toBeTruthy());
                expect(deps.processor.reset).not.toHaveBeenCalled();
                expect(deps.media.setAutoboot).not.toHaveBeenCalled();
            });

            it.each([
                [false, true],
                [true, false],
            ])("retries a failed load (Shift %s) as it was asked for, booting %s", async (shiftKey, boots) => {
                quietErrors();
                deps.media.loadDiscImage.mockRejectedValueOnce(new Error("HTTP 404"));
                await openWith([elite]);
                if (shiftKey) shiftClick(rowMain());
                else rowMain().click();
                await vi.waitFor(() => expect(bay(0).querySelector(".bay-retry").hidden).toBe(false));
                deps.media.loadDiscImage.mockResolvedValue(ssd());
                bay(0).querySelector(".bay-retry").click();
                await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
                expect(deps.autoboot).toHaveBeenCalledTimes(boots ? 1 : 0);
                expect(urlState.params.autoboot).toBe(boots ? true : undefined);
            });

            it.each([
                ["without autoboot", false],
                ["with autoboot", true],
            ])("retries a link's failed load for a link %s, booting %s", async (_, boots) => {
                if (boots) urlState.set({ autoboot: true });
                await failedStartupLoad("sth:A/elite.zip");
                deps.media.loadDiscImage.mockResolvedValue(ssd());
                await openWith([elite]);
                bay(0).querySelector(".bay-retry").click();
                await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
                expect(deps.autoboot).toHaveBeenCalledTimes(boots ? 1 : 0);
            });

            it.each([
                ["without autoboot", false],
                ["with autoboot", true],
            ])(
                "fills the drive a link %s names on Google Drive once connected, booting %s, and stays open",
                async (_, boots) => {
                    if (boots) urlState.set({ autoboot: true });
                    const loaded = ssd("mine.ssd");
                    await failedStartupLoad(driveMine.ref);
                    deps.media.loadDiscImage.mockResolvedValue(loaded);
                    await openWith([elite]);
                    deps.media.listAll.mockResolvedValue({ descriptors: [elite, driveMine], failures: [] });
                    byId("media-connect-drive").click();
                    await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
                    expect(fdc.drives[0].disc === loaded).toBe(true);
                    expect(deps.media.loadDiscImage).toHaveBeenCalledWith(driveMine.ref, "auto");
                    expect(deps.autoboot).toHaveBeenCalledTimes(boots ? 1 : 0);
                    expect(panel().hidden).toBe(false);
                    expect(rowTitles()[0]).toBe("mine.ssd");
                    expect(text(rows()[0].querySelector(".detail"))).toContain("in drive 0");
                },
            );
        });

        it("describes Enter by the row it takes, not only by where the list is aimed", async () => {
            const chip = (name) =>
                [...document.querySelectorAll("#media-chips .media-chip")].find((c) => text(c) === name);
            await openWith([elite, chuckie]);
            aim("tape");
            chip("Discs").click();
            search("elite");
            expect(hint()).toEqual(["Enter boots from drive 0", "Shift+Enter loads without booting", "Esc closes"]);
            aim("0");
            chip("Tapes").click();
            search("chuckie");
            expect(hint()).toEqual(["Enter loads into the deck", "Esc closes"]);
        });

        it("notes a search once per opening, when the box first has something in it", async () => {
            const sent = sentEvents();
            const window = await openWith([elite]);
            for (const query of ["e", "el", ""]) search(query);
            window.close();
            window.open();
            search("x");
            expect(sent("feature_used").filter(({ action }) => action === "search")).toHaveLength(2);
        });

        it("does not fill a drive from Google Drive while a load of the user's own is in flight", async () => {
            await failedStartupLoad(driveMine.ref);
            let finishLoad;
            deps.media.loadDiscImage.mockReturnValueOnce(new Promise((resolve) => (finishLoad = resolve)));
            await openWith([elite]);
            rowMain().click();
            deps.media.listAll.mockResolvedValue({ descriptors: [elite, driveMine], failures: [] });
            byId("media-connect-drive").click();
            await vi.waitFor(() => expect(rowTitles()).toContain("mine.ssd"));
            // The startup attempt and the user's own load; nothing more for Drive.
            expect(deps.media.loadDiscImage).toHaveBeenCalledTimes(2);
            finishLoad(ssd());
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
            expect(urlState.params.disc1).toBe("hfe:A.hfe");
        });

        it("redraws the slots when a save state has been restored", async () => {
            const window = make();
            putDiscIn(0, ssd());
            fdc.drives[0].tracksPerStep = 2;
            slots().restored();
            expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);
            expect(window.isOpen).toBe(false);
        });

        it("reads the autoboot tick once the disc has arrived, not before", async () => {
            let finishLoad;
            deps.media.loadDiscImage.mockReturnValueOnce(new Promise((resolve) => (finishLoad = resolve)));
            await openWith([elite]);
            rowMain().click();
            setTick(false);
            finishLoad(ssd());
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });

        it("lists a file opened while it is up, and leaves a closed window to list it on opening", async () => {
            const window = await openWith([elite]);
            deps.media.listAll.mockResolvedValue({ descriptors: [elite, sessionMine], failures: [] });
            deps.media.dispatchEvent(new Event("files-changed"));
            await vi.waitFor(() => expect(rowTitles()).toContain("mine.ssd"));
            window.close();
            deps.media.listAll.mockClear();
            deps.media.dispatchEvent(new Event("files-changed"));
            expect(deps.media.listAll).not.toHaveBeenCalled();
        });

        it("marks a file opened this session as in the slot that holds it", async () => {
            await openWith([sessionMine]);
            putDiscIn(1, ssd("mine.ssd"), sessionMine.ref);
            expect(text(rows()[0].querySelector(".detail"))).toContain("in drive 1");
        });

        it("tells apart, to a screen reader too, two files opened under one name", async () => {
            await openWith([
                describeSessionFile("1/game.ssd", "game.ssd", "disc", { order: 1, count: 2 }),
                describeSessionFile("2/game.ssd", "game.ssd", "disc", { order: 2, count: 2 }),
            ]);
            expect([rowMain(0), rowMain(1)].map((main) => main.getAttribute("aria-label"))).toEqual([
                "Boot game.ssd, opened this session, 1st of 2, This session from drive 0",
                "Boot game.ssd, opened this session, 2nd of 2, This session from drive 0",
            ]);
        });

        it("shows a load in the bay while it happens, and a failure with Retry afterwards", async () => {
            quietErrors();
            let fail;
            deps.media.loadDiscImage.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
            await openWith([elite]);
            rowMain().click();
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("busy"));
            expect(text(bay(0).querySelector(".bay-status"))).toBe("loading Elite from HFE archive…");
            fail(new Error("HTTP 404"));
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("empty"));
            expect(text(bay(0).querySelector(".bay-fail"))).toBe("could not load Elite: HTTP 404");
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(false);
            expect(urlState.params.disc1).toBeUndefined();
            deps.media.loadDiscImage.mockResolvedValue(ssd());
            bay(0).querySelector(".bay-retry").click();
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(true);
        });

        it("clears a failure when a disc reaches the drive some other way", async () => {
            quietErrors();
            deps.media.loadDiscImage.mockRejectedValue(new Error("HTTP 404"));
            await openWith([elite]);
            rowMain().click();
            await vi.waitFor(() => expect(bay(0).querySelector(".bay-retry").hidden).toBe(false));
            putDiscIn(0, ssd("dropped.ssd"));
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(true);
            expect(text(bay(0).querySelector(".bay-fail"))).toBe("");
        });

        it("shows a tape that could not be loaded on the deck, with Retry", async () => {
            quietErrors();
            deps.media.loadTapeImage.mockRejectedValueOnce(new Error("offline"));
            await openWith([chuckie]);
            byId("deck-window").click();
            rowMain().click();
            await vi.waitFor(() => expect(byId("deck-retry").hidden).toBe(false));
            expect(text(byId("deck-fail"))).toBe("could not load Chuckie: offline");
            const loadedTape = { name: "Chuckie.uef", position: 0 };
            deps.media.loadTapeImage.mockResolvedValue(loadedTape);
            byId("deck-retry").click();
            await vi.waitFor(() => expect(tapeInterface.tape).toBe(loadedTape));
            expect(byId("deck-retry").hidden).toBe(true);
        });

        it("notes each load with the row it was picked from, naming the user's own media only by its source", async () => {
            const sent = sentEvents();
            deps.media.loadDiscImage.mockResolvedValue(ssd());
            deps.media.loadTapeImage.mockResolvedValue({ name: "Mine.uef", position: 0 });
            const tape = { ...chuckie, ref: "session:1/Mine.uef", title: "Mine.uef", source: "session" };
            await openWith([saves, tape]);
            rowMain().click();
            await vi.waitFor(() => expect(sent("media_load")).toHaveLength(1));
            await openWith([saves, tape]);
            byId("deck-window").click();
            rowFor("Mine.uef").querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(sent("media_load")).toHaveLength(2));
            await openWith([saves, tape]);
            rowFor("saves.ssd").querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(sent("media_load")).toHaveLength(3));
            const disc = { source: "browser", kind: "disc", slot: "drive0", ref: "browser", result: "loaded" };
            expect(sent("media_load")).toEqual([
                { ...disc, entry: "list" },
                { source: "session", kind: "tape", slot: "deck", entry: "list", ref: "session", result: "loaded" },
                { ...disc, entry: "recent" },
            ]);
        });

        it("loads a tape into the deck from its row, unfolding the deck", async () => {
            const loadedTape = { name: "Chuckie.uef", position: 0 };
            deps.media.loadTapeImage.mockResolvedValue(loadedTape);
            await openWith([chuckie]);
            byId("deck-window").click();
            expect(rows()[0].querySelector(".media-keycap").textContent).toBe("T");
            expect(rows()[0].querySelector(".media-target")).toBeNull();
            byId("deck-hide").click();
            expect(panel().classList.contains("deck-collapsed")).toBe(true);
            rowMain().click();
            await vi.waitFor(() => expect(tapeInterface.tape).toBe(loadedTape));
            expect(urlState.params.tape).toBe("sth:AnF/Chuckie.zip");
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
            expect(panel().hidden).toBe(true);
            expect(text(rows()[0].querySelector(".detail"))).toContain("in the deck");
        });

        it("opens a file into the aimed drive from the footer, and connects Google Drive", async () => {
            deps.media.openFile.mockResolvedValue({
                kind: "disc",
                name: "mine.ssd",
                driveIndex: 1,
                words: "Loaded mine.ssd into drive 1.",
            });
            await openWith([]);
            bay(1).querySelector(".bay-slot").click();
            pickFile("mine.ssd");
            await vi.waitFor(() => expect(deps.media.openFile).toHaveBeenCalledWith(expect.anything(), 1, "file"));
            expect(panel().hidden).toBe(true);
            byId("media-connect-drive").click();
            await vi.waitFor(() => expect(deps.driveSource.connect).toHaveBeenCalled());
            expect(deps.media.listAll).toHaveBeenCalledTimes(2);
        });

        it("stays open, with no toast, when a save state could not be restored", async () => {
            let finishOpen;
            deps.media.openFile.mockReturnValue(new Promise((resolve) => (finishOpen = resolve)));
            await openWith([]);
            pickFile("bad.snp");
            await vi.waitFor(() => expect(deps.media.openFile).toHaveBeenCalled());
            finishOpen(null);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(panel().hidden).toBe(false);
            expect(toasts()).toEqual([]);
        });

        it.each([
            ["picked in the footer", pickFile],
            ["dropped on the page", dropFile],
        ])("reports a file %s that could not be opened, and stays open", async (_, open) => {
            quietErrors();
            deps.media.openFile.mockRejectedValue(new Error("not a disc"));
            await openWith([]);
            open("mine.txt");
            await vi.waitFor(() => expect(toasts()).toEqual([expect.stringContaining("not a disc")]));
            expect(panel().hidden).toBe(false);
        });

        it("shows the newest listing when an older one arrives after it", async () => {
            const stale = { ...elite, title: "Stale" };
            let answerFirst;
            deps.media.listAll
                .mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)))
                .mockResolvedValueOnce({ descriptors: [elite], failures: [] });
            const window = make();
            window.open();
            expect(text(document.querySelector("#media-list .notice"))).toBe("Fetching the archives…");
            expect(byId("media-count").textContent).toBe("");
            byId("media-connect-drive").click();
            await vi.waitFor(() => expect(rowTitles()).toEqual(["Elite"]));
            answerFirst({ descriptors: [stale], failures: [] });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(rowTitles()).toEqual(["Elite"]);
        });

        it("caps the rows and says so, until the search narrows them", async () => {
            const many = Array.from({ length: 120 }, (_, i) => ({ ...elite, ref: `hfe:${i}.hfe`, title: `Disc ${i}` }));
            await openWith(many);
            expect(rows().length).toBe(100);
            expect(text(byId("media-count"))).toBe("showing 100 of 120; keep typing to narrow it");
            search("Disc 11");
            expect(text(byId("media-count"))).toBe("11 of 120");
        });
    });

    describe("a disc that needs another machine", () => {
        const paradroid = {
            ref: "bitshifters:bs-paradroid.ssd",
            kind: "disc",
            title: "Paradroid",
            source: "bitshifters",
            requires: MachineRequirements.Master,
        };
        const navigatedTo = () => urlState.navigatedTo;

        beforeEach(() => stubNavigation(urlState));

        it("switches machine without asking on a booting shift-click, leaving word for the next page", async () => {
            await openWith([paradroid]);
            setTick(false);
            shiftClick(rowMain());
            await vi.waitFor(() =>
                expect(navigatedTo()).toBe(
                    "https://bbc.example/?autoboot&disc1=bitshifters:bs-paradroid.ssd&model=Master",
                ),
            );
            expect(sessionStorage.getItem("jsbeeb-pending-switch")).toBe("Switched to a BBC Master 128 for Paradroid");
            expect(confirm).not.toHaveBeenCalled();
            expect(deps.media.loadDiscImage).not.toHaveBeenCalled();
            expect(slots().recent.rank(paradroid)).toBe(0);
        });

        it("asks on a shift-click, which only loads: yes switches with no boot, no loads it here", async () => {
            confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
            deps.media.loadDiscImage.mockResolvedValue(ssd());
            const window = await openWith([paradroid]);
            shiftClick(rowMain());
            await vi.waitFor(() =>
                expect(navigatedTo()).toBe("https://bbc.example/?disc1=bitshifters:bs-paradroid.ssd&model=Master"),
            );
            expect(confirm).toHaveBeenCalledWith(
                expect.stringContaining("Paradroid needs"),
                "Switch machine",
                "Load it here",
            );
            expect(deps.media.loadDiscImage).not.toHaveBeenCalled();
            expect(slots().recent.rank(paradroid)).toBe(0);
            shiftClick(rowMain());
            await vi.waitFor(() => expect(deps.media.loadDiscImage).toHaveBeenCalledWith(paradroid.ref, "auto"));
            await vi.waitFor(() => expect(window.isOpen).toBe(false));
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });
    });

    describe("the page as a drop zone", () => {
        const zone = () => byId("drop-zone");

        it("shows where a file will go while one is over the page, and hides when it leaves", () => {
            make();
            expect(zone().hidden).toBe(true);
            dragEvent("dragenter");
            expect(zone().hidden).toBe(false);
            expect(text(zone())).toContain("a disc goes into drive 0");
            dragEvent("dragenter", byId("leds"));
            dragEvent("dragleave", byId("leds"));
            expect(zone().hidden).toBe(false);
            dragEvent("dragleave");
            expect(zone().hidden).toBe(true);
        });

        it("takes a drag of files, and refuses one that carries none so a dropped link cannot replace the page", () => {
            make();
            expect(dragEvent("dragover").dataTransfer.dropEffect).toBe("copy");
            const notFiles = dragCarrying(["text/uri-list"]);
            expect(notFiles("dragenter").defaultPrevented).toBe(false);
            expect(zone().hidden).toBe(true);
            const over = notFiles("dragover");
            expect(over.defaultPrevented).toBe(true);
            expect(over.dataTransfer.dropEffect).toBe("none");
            expect(notFiles("drop").defaultPrevented).toBe(true);
            expect(deps.media.openFile).not.toHaveBeenCalled();
        });

        it("leaves a drop to an element that takes its own, saying what it does there", async () => {
            make();
            const claimant = document.createElement("div");
            claimant.dataset.dropWhat = "Drop a label file";
            claimant.dataset.dropInto = "labels name addresses";
            document.body.append(claimant);
            dragEvent("dragenter");
            dragEvent("dragover", claimant);
            expect(text(zone())).toBe("Drop a label file labels name addresses");
            dragEvent("dragover");
            expect(text(zone())).toContain("Drop a disc, tape or save state");
            dragEvent("drop", claimant);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(zone().hidden).toBe(true);
            expect(deps.media.openFile).not.toHaveBeenCalled();
        });

        it("opens a dropped file into the aimed drive and says so", async () => {
            deps.media.openFile.mockResolvedValue({
                kind: "disc",
                name: "mine.ssd",
                driveIndex: 1,
                words: "Loaded mine.ssd into drive 1.",
            });
            const window = await openWith([]);
            aim("1");
            dragEvent("dragenter");
            dropFile("mine.ssd");
            await vi.waitFor(() => expect(deps.media.openFile).toHaveBeenCalledWith(expect.anything(), 1, "drop"));
            await vi.waitFor(() =>
                expect(toasts()).toEqual([expect.stringContaining("Loaded mine.ssd into drive 1.")]),
            );
            expect(zone().hidden).toBe(true);
            expect(window.isOpen).toBe(false);
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });

        it.each([true, false])("boots a disc dropped into drive 0 as Autoboot says, ticked %s", async (ticked) => {
            deps.media.openFile.mockResolvedValue({
                kind: "disc",
                name: "game.ssd",
                ref: "session:1/game.ssd",
                driveIndex: 0,
                words: "Loaded game.ssd into drive 0.",
            });
            make();
            setTick(ticked);
            dropFile("game.ssd");
            await vi.waitFor(() => expect(toasts()).toHaveLength(1));
            expect(deps.autoboot).toHaveBeenCalledTimes(ticked ? 1 : 0);
            expect(deps.processor.reset).toHaveBeenCalledTimes(ticked ? 1 : 0);
        });

        it("does not boot a tape or a restored state, whatever the tick says", async () => {
            deps.media.openFile.mockResolvedValue({ kind: "tape", name: "t.uef", words: "Loaded t.uef as the tape." });
            make();
            dropFile("t.uef");
            await vi.waitFor(() => expect(toasts()).toHaveLength(1));
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });
    });

    describe("the footer", () => {
        const discForm = () => byId("media-new-disc-form");

        it("starts Autoboot ticked, and remembers an untick nowhere", async () => {
            vi.spyOn(urlState, "updateUrl");
            await openWith();
            expect(autobootTick().checked).toBe(true);
            setTick(false);
            expect(urlState.params).toEqual({});
            expect(urlState.updateUrl).not.toHaveBeenCalled();
            expect(Object.keys(window.localStorage).filter((key) => /autoboot/i.test(key))).toEqual([]);
        });

        it("offers this browser for a new disc each time the form opens, however the last one was made", async () => {
            deps.driveSource.connected = true;
            deps.driveSource.createBlank.mockResolvedValue({ ref: "gd:x/a.ssd", disc: ssd("a.ssd") });
            await openWith();
            makeNewDisc("a.ssd", "gdrive");
            await vi.waitFor(() => expect(deps.driveSource.createBlank).toHaveBeenCalled());
            byId("media-new-disc").click();
            expect(document.querySelector('#media-new-disc-where input[value="browser"]').checked).toBe(true);
        });

        it.each`
            where        | aimed  | typed          | asked               | param      | autoboot
            ${"browser"} | ${"0"} | ${"blank"}     | ${"local:blank"}    | ${"disc1"} | ${undefined}
            ${"browser"} | ${"1"} | ${"mine.hfe"}  | ${"local:mine.ssd"} | ${"disc2"} | ${true}
            ${"gdrive"}  | ${"0"} | ${"fresh.ssd"} | ${"fresh.ssd"}      | ${"disc1"} | ${undefined}
            ${"gdrive"}  | ${"0"} | ${"fresh.hfe"} | ${"fresh.hfe"}      | ${"disc1"} | ${undefined}
        `(
            "makes a blank disc in $where called $typed in drive $aimed, booting nothing",
            async ({ where, aimed, typed, asked, param, autoboot }) => {
                const onDrive = where === "gdrive";
                deps.driveSource.connected = onDrive;
                const blank = ssd("blank.ssd");
                deps.media.loadDiscImage.mockResolvedValue(blank);
                deps.driveSource.createBlank.mockResolvedValue({ ref: "gd:xyz/fresh.ssd", disc: blank });
                urlState.set({ autoboot: true });
                await openWith();
                expect(byId("media-connect-drive").hidden).toBe(onDrive);
                aim(aimed);
                byId("media-new-disc").click();
                expect(discForm().hidden).toBe(false);
                expect(byId("media-new-disc-drive-option").hidden).toBe(!onDrive);
                submitDiscForm(typed, where);
                await vi.waitFor(() => expect(fdc.drives[aimed].disc === blank).toBe(true));
                expect([...deps.media.loadDiscImage.mock.calls, ...deps.driveSource.createBlank.mock.calls]).toEqual([
                    [asked, "auto"],
                ]);
                expect(urlState.params[param]).toBe(onDrive ? "gd:xyz/fresh.ssd" : asked);
                expect(discForm().hidden).toBe(true);
                expect(panel().hidden).toBe(true);
                expect(deps.processor.reset).not.toHaveBeenCalled();
                expect(urlState.params.autoboot).toBe(autoboot);
            },
        );

        it("leaves the drive empty, with nothing to retry, when Google Drive cannot make the disc", async () => {
            quietErrors();
            deps.driveSource.connected = true;
            deps.driveSource.createBlank.mockRejectedValue(new Error("quota"));
            await openWith();
            makeNewDisc("fresh.ssd", "gdrive");
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("busy"));
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("empty"));
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(true);
            expect(discForm().hidden).toBe(true);
            expect(panel().hidden).toBe(false);
        });

        it("copies the disc in a drive to Google Drive from its Save menu, as a sector image", async () => {
            deps.driveSource.connected = true;
            const copy = ssd("mine.ssd");
            deps.driveSource.createFrom.mockResolvedValue({ ref: "gd:xyz/mine.ssd", disc: copy });
            putDiscIn(1, ssd("Superior/Exile.ssd"));
            await openWith();
            bay(1).querySelector(".bay-save-drive").click();
            expect(discForm().hidden).toBe(false);
            expect(byId("media-new-disc-where").hidden).toBe(true);
            expect(byId("media-new-disc-name").value).toBe("Exile.ssd");
            expect(text(byId("media-new-disc-label"))).toContain("drive 1");
            submitDiscForm("mine.hfe");
            await vi.waitFor(() => expect(fdc.drives[1].disc === copy).toBe(true));
            const [name, data, layout] = deps.driveSource.createFrom.mock.calls[0];
            expect(name).toBe("mine.ssd");
            expect(data.length).toBeGreaterThan(0);
            expect(layout).toBe("auto");
            expect(urlState.params.disc2).toBe("gd:xyz/mine.ssd");
        });

        it("connects Google Drive first when the Save menu asks for a copy there", async () => {
            deps.driveSource.connect.mockResolvedValue(false);
            putDiscIn(0, ssd());
            await openWith();
            bay(0).querySelector(".bay-save-drive").click();
            await vi.waitFor(() => expect(deps.driveSource.connect).toHaveBeenCalled());
            expect(discForm().hidden).toBe(true);
        });

        it("puts the new disc form away when the window closes", async () => {
            const window = await openWith();
            byId("media-new-disc").click();
            window.close();
            expect(discForm().hidden).toBe(true);
        });

        it("cancels the new disc form back to the search box", async () => {
            await openWith();
            byId("media-new-disc").click();
            byId("media-new-disc-cancel").click();
            expect(discForm().hidden).toBe(true);
            expect(document.activeElement).toBe(byId("media-search"));
        });
    });

    it("offers only the deck, unfolded, and tapes on a machine without disc drives", async () => {
        deps.model.hasDiscDrives = false;
        putDiscIn(0, ssd());
        const window = await openWith([elite, chuckie]);
        expect(panel().querySelector(".media-case").hidden).toBe(true);
        expect(panel().classList.contains("deck-collapsed")).toBe(false);
        expect(document.querySelector('#media-into [data-target="0"]').hidden).toBe(true);
        expect(byId("media-new-disc").hidden).toBe(true);
        expect(byId("media-connect-drive").hidden).toBe(true);
        expect(rowTitles()).toEqual(["Chuckie"]);
        const chips = [...document.querySelectorAll("#media-chips .media-chip")].map((c) => c.textContent);
        expect(chips).toEqual(["All", "STH archive 1", "Tapes"]);
        expect(byId("media-count").textContent).toBe("1 of 1");
        expect(byId("media-summary").textContent).toBe("tape: empty");
        window.close();
        window.openFor(0);
        expect(byId("deck-window").classList.contains("target")).toBe(true);
        expect(byId("media-search").placeholder).toBe("Search for a tape for the deck");
        expect(byId("media-open-label").title).toBe("Open a tape image from this computer");
    });

    describe("what a slot is called", () => {
        it("drops the folder and extension, and cuts a long name in the middle", () => {
            expect(shortName("Superior/Exile.ssd")).toBe("Exile");
            expect(shortName("ChuckieEgg_B.uef")).toBe("ChuckieEgg_B");
            expect(shortName("Elite-MasterAndTubeEnhanced.ssd")).toBe("Elite-M…nced");
            expect(shortName("3A1DAB83.hfe")).toBe("3A1DAB83");
        });

        it("shows the list's title for a disc the machine knows only by its file name", async () => {
            deps.media.listAll.mockResolvedValue({
                descriptors: [{ ...elite, ref: "hfe:3A1DAB83.hfe", title: "Calligraphy" }],
                failures: [],
            });
            const window = make();
            putDiscIn(0, discFor("3A1DAB83.hfe", toHfe(ssd("x.ssd"))), "hfe:3A1DAB83.hfe");
            expect(text(bay(0).querySelector(".bay-title"))).toBe("3A1DAB83.hfe");
            window.open();
            await vi.waitFor(() => expect(text(bay(0).querySelector(".bay-title"))).toBe("Calligraphy"));
            expect(readout("0")).toBe("Calligraphy");
        });
    });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaWindow, shortName } from "../../src/web/media-window.js";
import { MachineRequirements, describeRef, describeSessionFile, sourceOf } from "../../src/web/media-catalogue.js";
import { MachineSwitch } from "../../src/web/machine-switch.js";
import { Schemas } from "../../src/media-resolver.js";
import { MediaSlots } from "../../src/web/media-slots.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
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
        const model = { isAtom: false };
        confirm = vi.fn();
        deps = {
            media,
            drives,
            processor,
            model,
            loop,
            visualiser: { openOn: vi.fn() },
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
        window.history.replaceState(null, "", window.location.pathname);
        sessionStorage.clear();
        return teardownDom();
    });

    let startTicked;
    beforeEach(() => (startTicked = true));
    const make = () => {
        made = new MediaWindow(deps);
        if (!startTicked) setTick(false);
        return made;
    };
    const panel = () => document.getElementById("media-panel");
    const bay = (driveIndex) => document.querySelector(`.bay[data-drive="${driveIndex}"]`);
    const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
    const readout = (slot) => text(document.querySelector(`#leds .slot-readout[data-slot="${slot}"] .line`));
    const slots = () => deps.media.slots;
    /** What the URL naming a Drive disc leaves behind at startup, before Drive is connected. */
    const failedStartupLoad = async (ref) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
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
    const pressEnter = (shiftKey = false) =>
        document
            .getElementById("media-search")
            .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey, bubbles: true, cancelable: true }));
    /** Opens the window over a list of `descriptors`, and waits for it to have drawn them. */
    const openWith = async (descriptors = [], failures = []) => {
        deps.media.listAll.mockResolvedValue({ descriptors, failures });
        const window = make();
        window.open();
        await vi.waitFor(() => expect(document.getElementById("media-count").textContent).not.toBe(""));
        return window;
    };

    describe("opening and closing", () => {
        it("opens from the menu items and the LED panel readouts, and closes from its button", () => {
            const window = make();
            expect(panel().hidden).toBe(true);
            document.getElementById("navbarMedia").click();
            expect(window.isOpen).toBe(true);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
            document.getElementById("media-close").click();
            expect(window.isOpen).toBe(false);
            document.querySelector('#leds .slot-readout[data-slot="tape"]').click();
            expect(panel().hidden).toBe(false);
        });

        it("aims the list at the slot whose line in the LED panel was clicked, unfolding it", () => {
            make();
            document.querySelector('#leds .slot-readout[data-slot="1"]').click();
            expect(bay(1).classList.contains("target")).toBe(true);
            expect(bay(1).classList.contains("folded")).toBe(false);
            document.querySelector('#leds .slot-readout[data-slot="tape"]').click();
            expect(document.getElementById("deck-window").classList.contains("target")).toBe(true);
            expect(bay(1).classList.contains("target")).toBe(false);
        });

        it("aims at drive 0 again whenever the Media button opens it", () => {
            make();
            document.querySelector('#leds .slot-readout[data-slot="1"]').click();
            expect(bay(1).classList.contains("target")).toBe(true);
            document.getElementById("navbarMedia").click();
            expect(bay(0).classList.contains("target")).toBe(true);
            expect(bay(1).classList.contains("target")).toBe(false);
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
            expect(text(document.getElementById("media-summary"))).toBe("0: empty · 1: ELITE.ssd · tape: empty");
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
            putDiscIn(0, discFor("blank.ssd", ssdImage()));
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
            putDiscIn(0, discFor("a.ssd", ssdImage()));
            bay(0).querySelector(".pitch .track").click();
            expect(fdc.drives[0].tracksPerStep).toBe(2);
            expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);
            bay(0).querySelector(".pitch .track").click();
            expect(fdc.drives[0].tracksPerStep).toBe(1);
        });

        it("ejects from the latch", () => {
            make();
            putDiscIn(0, discFor("a.ssd", ssdImage()));
            expect(text(bay(0).querySelector(".bay-title"))).toBe("a.ssd");
            bay(0).querySelector(".bay-eject").click();
            expect(fdc.drives[0].disc).toBeUndefined();
            expect(bay(0).dataset.state).toBe("empty");
            expect(readout("0")).toBe("empty");
            expect(text(bay(0).querySelector(".bay-title"))).toBe("");
            expect(text(bay(0).querySelector(".bay-sub"))).toBe("");
        });

        it("saves through the drives and opens the surface on its own drive", () => {
            make();
            putDiscIn(1, discFor("a.ssd", ssdImage()));
            const ssd = vi.spyOn(deps.drives, "downloadSsdOrDsd").mockResolvedValue();
            const hfe = vi.spyOn(deps.drives, "downloadHfe").mockImplementation(() => {});
            bay(1).querySelector(".bay-save-ssd").click();
            bay(1).querySelector(".bay-save-hfe").click();
            bay(1).querySelector(".bay-surface").click();
            expect(ssd).toHaveBeenCalledWith(1);
            expect(hfe).toHaveBeenCalledWith(1);
            expect(deps.visualiser.openOn).toHaveBeenCalledWith(1);
        });

        it("nudges the search box when a slot asks for something to load", () => {
            vi.useFakeTimers();
            make();
            const box = document.getElementById("media-search");
            bay(1).querySelector(".bay-slot").click();
            expect(box.classList.contains("attention")).toBe(true);
            vi.runAllTimers();
            expect(box.classList.contains("attention")).toBe(false);
        });

        it("selects what was in the search box when aimed, so typing replaces it", () => {
            make();
            const box = document.getElementById("media-search");
            box.value = "old";
            bay(1).querySelector(".bay-slot").click();
            expect(box.selectionStart).toBe(0);
            expect(box.selectionEnd).toBe(3);
        });

        it("aims the list at its drive when its slot is clicked", () => {
            make();
            bay(1).querySelector(".bay-slot").click();
            expect(bay(1).classList.contains("target")).toBe(true);
            expect(bay(0).classList.contains("target")).toBe(false);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
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

        it("starts empty with every key up and disabled", () => {
            make();
            expect(document.getElementById("deck-empty").hidden).toBe(false);
            for (const id of ["tape-rewind", "tape-play", "tape-stop", "tape-eject"])
                expect(document.getElementById(id).disabled).toBe(true);
            expect(readout("tape")).toBe("empty");
        });

        it("shows the tape and its counter, and where it came from", () => {
            make();
            putTapeIn(tape(0.5), "sth:Games/Chuckie.zip");
            expect(document.getElementById("deck-cassette").hidden).toBe(false);
            expect(text(document.getElementById("deck-tape-title"))).toBe("chuckie.uef");
            expect(text(document.getElementById("deck-status"))).toBe("chuckie.uef · STH archive · motor off");
            expect(text(document.getElementById("tape-counter"))).toBe("499");
            expect(readout("tape")).toBe("chuckie499");
            expect(text(document.querySelector('#leds [data-slot="tape"] .counter'))).toBe("499");
        });

        it("counts from wherever the counter was reset", () => {
            make();
            putTapeIn(tape(0.5));
            document.getElementById("tape-counter-reset").click();
            expect(text(document.getElementById("tape-counter"))).toBe("000");
            tapeInterface.tape.position = 0.51;
            tick();
            expect(text(document.getElementById("tape-counter"))).toBe("010");
        });

        it("runs the reels and the data light while the motor is on", () => {
            make();
            putTapeIn(tape());
            tapeInterface.motorOn = true;
            tick();
            expect(document.getElementById("media-deck").classList.contains("motor")).toBe(true);
            expect(document.getElementById("deck-data").classList.contains("on")).toBe(true);
            expect(document.getElementById("tape-play").getAttribute("aria-pressed")).toBe("true");
            tapeInterface.motorOn = false;
            tick();
            expect(document.getElementById("media-deck").classList.contains("motor")).toBe(false);
        });

        it("works PLAY and STOP as a latch on a BBC, which the motor relay runs against", () => {
            make();
            putTapeIn(tape());
            expect(document.getElementById("tape-play").disabled).toBe(true);
            expect(document.getElementById("tape-play").getAttribute("aria-pressed")).toBe("true");
            expect(document.getElementById("tape-stop").disabled).toBe(false);
            tapeInterface.motorOn = true;
            tick();
            expect(document.getElementById("media-deck").classList.contains("motor")).toBe(true);
            expect(text(document.getElementById("deck-status"))).toContain("playing");
            document.getElementById("tape-stop").click();
            expect(tapeInterface.pressStop).toHaveBeenCalled();
            expect(document.getElementById("tape-play").disabled).toBe(false);
            expect(document.getElementById("tape-stop").disabled).toBe(true);
            tick();
            expect(document.getElementById("media-deck").classList.contains("motor")).toBe(false);
            expect(text(document.getElementById("deck-status"))).toContain("stopped");
            document.getElementById("tape-play").click();
            expect(tapeInterface.pressPlay).toHaveBeenCalled();
            tick();
            tapeInterface.motorOn = false;
            tick();
            expect(text(document.getElementById("deck-status"))).toContain("motor off");
        });

        it("works PLAY and STOP as the motor itself on an Atom, with nothing to say about a relay", () => {
            deps.model.isAtom = true;
            tapeInterface.playPressed = false;
            make();
            putTapeIn(tape());
            expect(text(document.getElementById("deck-status"))).toContain("stopped");
            document.getElementById("tape-play").click();
            expect(tapeInterface.pressPlay).toHaveBeenCalled();
            tapeInterface.motorOn = true;
            tick();
            expect(document.getElementById("tape-play").disabled).toBe(true);
            expect(text(document.getElementById("deck-status"))).toContain("playing");
            document.getElementById("tape-stop").click();
            expect(tapeInterface.pressStop).toHaveBeenCalled();
            tapeInterface.motorOn = false;
            tick();
            expect(text(document.getElementById("deck-status"))).not.toContain("motor off");
        });

        it("starts a new tape's counter from zero, whatever the last one was reset to", () => {
            make();
            putTapeIn(tape(0.5));
            document.getElementById("tape-counter-reset").click();
            expect(text(document.getElementById("tape-counter"))).toBe("000");
            slots().eject(slots().deck);
            putTapeIn(tape(0));
            expect(text(document.getElementById("tape-counter"))).toBe("000");
        });

        it("blanks the readout's counter when the tape is ejected, and the deck's counter reads zero", () => {
            make();
            putTapeIn(tape(0.5));
            expect(text(document.querySelector('#leds [data-slot="tape"] .counter'))).toBe("499");
            slots().eject(slots().deck);
            expect(text(document.querySelector('#leds [data-slot="tape"] .counter'))).toBe("");
            expect(text(document.getElementById("tape-counter"))).toBe("000");
            putTapeIn(tape(0.5));
            expect(text(document.querySelector('#leds [data-slot="tape"] .counter'))).toBe("499");
        });

        it("rewinds and ejects from the keys", () => {
            make();
            putTapeIn(tape());
            document.getElementById("tape-rewind").click();
            expect(tapeInterface.rewindTape).toHaveBeenCalled();
            document.getElementById("tape-eject").click();
            expect(tapeInterface.tape).toBeUndefined();
            expect(document.getElementById("deck-empty").hidden).toBe(false);
        });

        it("aims the list at the deck when its window is clicked", () => {
            make();
            document.getElementById("deck-window").click();
            expect(document.getElementById("deck-window").classList.contains("target")).toBe(true);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
        });

        it("starts folded on a BBC, unfolds when a tape goes in, and folds and unfolds on a click", () => {
            make();
            expect(panel().classList.contains("deck-collapsed")).toBe(true);
            expect(text(document.getElementById("deck-bar-name"))).toBe("empty");
            putTapeIn(tape());
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
            document.getElementById("deck-hide").click();
            expect(panel().classList.contains("deck-collapsed")).toBe(true);
            expect(text(document.getElementById("deck-bar-name"))).toBe("chuckie.uef");
            document.getElementById("deck-toggle").click();
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
        });

        it("cannot be folded while a tape is in it", () => {
            make();
            putTapeIn(tape());
            expect(document.getElementById("deck-hide").hidden).toBe(true);
            slots().eject(slots().deck);
            expect(document.getElementById("deck-hide").hidden).toBe(false);
        });

        it("starts unfolded on an Atom", () => {
            deps.model.isAtom = true;
            make();
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
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

        it("unfolds drive 1 when the list is aimed at it", () => {
            make();
            document.querySelector('#media-into [data-target="1"]').click();
            expect(bay(1).classList.contains("folded")).toBe(false);
        });

        it("unfolds drive 1 when a disc goes into it, however it got there", () => {
            make();
            putDiscIn(1, discFor("b.ssd", ssdImage()));
            expect(bay(1).classList.contains("folded")).toBe(false);
            expect(text(bay(1).querySelector(".bay-bar-name"))).toBe("b.ssd");
        });

        it("opens with the list whichever way it is opened, and the list folds and unfolds on request", () => {
            putDiscIn(0, discFor("a.ssd", ssdImage()));
            const window = make();
            document.querySelector('#leds .slot-readout[data-slot="0"]').click();
            expect(window.isOpen).toBe(true);
            expect(panel().classList.contains("list-collapsed")).toBe(false);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
            document.getElementById("list-hide").click();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            document.getElementById("list-toggle").click();
            expect(panel().classList.contains("list-collapsed")).toBe(false);
        });

        it("lets drive 1 fold away again once it is empty, but not while it holds a disc", () => {
            make();
            bay(1).querySelector(".bay-bar").click();
            expect(bay(1).querySelector(".bay-hide").hidden).toBe(false);
            bay(1).querySelector(".bay-hide").click();
            expect(bay(1).classList.contains("folded")).toBe(true);
            putDiscIn(1, discFor("b.ssd", ssdImage()));
            expect(bay(1).classList.contains("folded")).toBe(false);
            expect(bay(1).querySelector(".bay-hide").hidden).toBe(true);
            expect(bay(0).querySelector(".bay-hide").hidden).toBe(true);
        });

        it("lets the latch of an empty drive aim the list at it, unfolding the list", () => {
            putDiscIn(0, discFor("a.ssd", ssdImage()));
            make();
            document.querySelector('#leds .slot-readout[data-slot="0"]').click();
            document.getElementById("list-hide").click();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            bay(0).querySelector(".bay-eject").click();
            expect(fdc.drives[0].disc).toBeUndefined();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            bay(0).querySelector(".bay-eject").click();
            expect(panel().classList.contains("list-collapsed")).toBe(false);
            expect(bay(0).classList.contains("target")).toBe(true);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
        });
    });

    describe("the list", () => {
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
        const rows = () => [...document.querySelectorAll("#media-list .media-row")];
        const rowTitles = () => rows().map((row) => text(row.querySelector(".title")));
        const shiftClick = (el) => el.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
        const search = (query) => {
            const box = document.getElementById("media-search");
            box.value = query;
            box.dispatchEvent(new Event("input"));
        };

        it("lists the discs every source offers once opened, with the search box focused and a chip per source", async () => {
            await openWith([elite, chuckie, saves]);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
            expect(rowTitles()).toEqual(["Elite", "saves.ssd"]);
            expect(text(document.getElementById("media-count"))).toBe("2 of 3");
            const chips = [...document.querySelectorAll("#media-chips .media-chip")].map((c) => c.textContent);
            expect(chips).toEqual(["All", "STH archive 1", "HFE archive 1", "This browser 1", "Discs", "Tapes"]);
            expect(text(rows()[1].querySelector(".detail"))).toContain("saves changes");
        });

        it("shows tapes when aimed at the deck, and either when the chips say so", async () => {
            await openWith([elite, chuckie, saves]);
            document.getElementById("deck-window").click();
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
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            await openWith([elite, saves]);
            const box = document.getElementById("media-search");
            box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
            expect(document.activeElement).toBe(rows()[0].querySelector(".media-row-main"));
            document.activeElement.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
            );
            expect(document.activeElement).toBe(rows()[1].querySelector(".media-row-main"));
            document.activeElement.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
            );
            document.activeElement.dispatchEvent(
                new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
            );
            expect(document.activeElement).toBe(box);
            box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            await vi.waitFor(() => expect(fdc.drives[0].disc).toBeTruthy());
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("hfe:A.hfe", "auto");
        });

        it("puts what was loaded most recently first, under a heading, until something is typed", async () => {
            const zalaga = { ...elite, ref: "hfe:Z.hfe", title: "Zalaga" };
            const headings = () => [...document.querySelectorAll("#media-list .media-heading")].map(text);
            putDiscIn(1, discFor("Z.ssd", ssdImage()), zalaga.ref);
            putTapeIn({ name: "chuckie.uef" }, chuckie.ref);
            putDiscIn(1, discFor("saves.ssd", ssdImage()), saves.ref);
            deps.media.loadDiscImage.mockResolvedValue(discFor("saves.ssd", ssdImage()));
            await openWith([elite, chuckie, saves, zalaga]);
            expect(rowTitles()).toEqual(["saves.ssd", "Zalaga", "Elite"]);
            expect(headings()).toEqual(["Recently loaded", "Everything else"]);
            for (const heading of document.querySelectorAll("#media-list .media-heading"))
                expect(heading.getAttribute("aria-hidden")).toBe("true");
            const mains = rows().map((row) => row.querySelector(".media-row-main"));
            expect(mains[1].getAttribute("aria-label")).toBe(
                "Boot Zalaga, Acornsoft, D1S1 · 40 · v1, HFE archive from drive 0, recently loaded",
            );
            expect(mains[1].title).toBe("Boot Zalaga, Acornsoft, D1S1 · 40 · v1, HFE archive from drive 0");
            expect(mains[2].getAttribute("aria-label")).not.toContain("recently loaded");
            const box = document.getElementById("media-search");
            const press = (key) =>
                document.activeElement.dispatchEvent(
                    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
                );
            box.focus();
            press("ArrowDown");
            expect(document.activeElement).toBe(rows()[0].querySelector(".media-row-main"));
            press("ArrowDown");
            press("ArrowDown");
            expect(text(document.activeElement.querySelector(".title"))).toBe("Elite");
            press("ArrowUp");
            expect(text(document.activeElement.querySelector(".title"))).toBe("Zalaga");
            search("s");
            expect(rowTitles()).toEqual(["saves.ssd", "Elite", "Zalaga"]);
            expect(headings()).toEqual([]);
            search("");
            box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
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
            document.getElementById("media-connect-drive").click();
            await vi.waitFor(() => expect(rowTitles()).toEqual(["Elite"]));
            expect(document.querySelector("#media-chips .media-chip").getAttribute("aria-pressed")).toBe("true");
        });

        it("links a row to the page about it when its source names one, and only then", async () => {
            const paradroid = {
                ...elite,
                ref: "bitshifters:bs-paradroid.ssd",
                title: "Paradroid",
                publisher: "Bitshifters",
                source: "bitshifters",
                url: "https://bitshifters.github.io/posts/prods/bs-paradroid.html",
            };
            await openWith([elite, paradroid]);
            const links = rows().map((row) => row.querySelector(".media-about"));
            expect(links[0]).toBeNull();
            expect(links[1].href).toBe(paradroid.url);
            expect(links[1].target).toBe("_blank");
            expect(links[1].title).toBe("About Paradroid at bitshifters.github.io");
        });

        it("links only to web pages, whatever a source's manifest says", async () => {
            const entryWith = (title, url) => ({
                ...elite,
                ref: `bitshifters:${title}.ssd`,
                title,
                source: "bitshifters",
                url,
            });
            // Rows come sorted by title.
            await openWith([
                entryWith("a script", "javascript:alert(1)"),
                entryWith("b data", "data:text/html,hi"),
                entryWith("c junk", "not a url"),
                entryWith("d plain", "http://example.com/page"),
            ]);
            const links = rows().map((row) => row.querySelector(".media-about"));
            expect(links.slice(0, 3)).toEqual([null, null, null]);
            expect(links[3].href).toBe("http://example.com/page");
        });

        it("says which sources could not be listed", async () => {
            await openWith([elite], ["sth: offline"]);
            expect(text(document.querySelector("#media-list .notice"))).toBe("Could not list sth: offline");
        });

        it("loads a disc into the aimed drive from the row, and the other drive from its button", async () => {
            const loaded = discFor("A.ssd", ssdImage());
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await openWith([elite]);
            expect(rows()[0].querySelector(".media-row-main").title).toMatch(/^Boot Elite.*from drive 0$/);
            expect(rows()[0].querySelector(".media-target").title).toBe("Load Elite into drive 1");
            expect(bay(1).classList.contains("folded")).toBe(true);
            rows()[0].querySelector(".media-target").click();
            expect(bay(1).classList.contains("folded")).toBe(false);
            await vi.waitFor(() => expect(fdc.drives[1].disc === loaded).toBe(true));
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("hfe:A.hfe", "auto");
            expect(urlState.params.disc2).toBe("hfe:A.hfe");
            expect(deps.processor.reset).not.toHaveBeenCalled();
            expect(panel().hidden).toBe(true);
            await vi.waitFor(() => expect(text(rows()[0].querySelector(".detail"))).toContain("in drive 1"));
            bay(1).querySelector(".bay-slot").click();
            expect(text(document.getElementById("media-open-text"))).toBe("Open a file into drive 1…");
            expect(rows()[0].querySelector(".media-keycap").textContent).toBe("1");
            expect(rows()[0].querySelector(".media-target").textContent).toBe("0");
            expect(rows()[0].querySelector(".media-row-main").title).toMatch(/^Load Elite.*into drive 1$/);
            expect(rows()[0].querySelector(".media-target").title).toBe("Boot Elite from drive 0");
        });

        it("is aimed from the Into control, which says where the list points", async () => {
            await openWith([elite]);
            const into = (target) => document.querySelector(`#media-into [data-target="${target}"]`);
            expect(into("0").getAttribute("aria-pressed")).toBe("true");
            into("1").click();
            expect(into("1").getAttribute("aria-pressed")).toBe("true");
            expect(into("0").getAttribute("aria-pressed")).toBe("false");
            expect(bay(1).classList.contains("target")).toBe(true);
            expect(document.getElementById("media-search").placeholder).toBe("Search for a disc for drive 1");
            expect(hint()).toEqual(["Enter loads into drive 1, which does not boot", "Esc closes"]);
            into("tape").click();
            expect(document.getElementById("deck-window").classList.contains("target")).toBe(true);
            expect(document.getElementById("media-search").placeholder).toBe("Search for a tape for the deck");
            expect(hint()).toEqual(["Enter loads into the deck", "Esc closes"]);
        });

        describe("with Autoboot ticked, as on a first visit", () => {
            it("says Enter boots and Shift+Enter only loads, and ticks the box", async () => {
                await openWith([elite]);
                expect(autobootTick().checked).toBe(true);
                expect(hint()).toEqual(["Enter boots from drive 0", "Shift+Enter loads without booting", "Esc closes"]);
            });

            it("boots on Enter, and the URL says so", async () => {
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                await openWith([elite]);
                pressEnter();
                await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalled());
                expect(deps.processor.reset).toHaveBeenCalledWith(true);
                expect(urlState.params).toMatchObject({ disc1: "hfe:A.hfe", autoboot: true });
            });

            it("boots on a click of the row, noting a boot from the window", async () => {
                const sent = sentEvents();
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                await openWith([elite]);
                rows()[0].querySelector(".media-row-main").click();
                await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalled());
                expect(sent("feature_used")).toEqual([
                    { feature: "media_window", action: "open" },
                    { feature: "media_window", action: "boot" },
                ]);
                expect(sent("media_load")).toEqual([expect.objectContaining({ entry: "list", slot: "drive0" })]);
            });

            it("loads without booting on Shift+Enter or a shift-click, taking autoboot out of the URL", async () => {
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                urlState.set({ autoboot: true });
                await openWith([elite]);
                pressEnter(true);
                await vi.waitFor(() => expect(fdc.drives[0].disc).toBeTruthy());
                expect(urlState.params.autoboot).toBeUndefined();
                urlState.set({ autoboot: true });
                made.open();
                shiftClick(rows()[0].querySelector(".media-row-main"));
                await vi.waitFor(() => expect(urlState.params.autoboot).toBeUndefined());
                expect(deps.media.loadDiscImage).toHaveBeenCalledTimes(2);
                expect(deps.processor.reset).not.toHaveBeenCalled();
                expect(deps.autoboot).not.toHaveBeenCalled();
            });

            it("leaves the URL alone when a load fails", async () => {
                vi.spyOn(console, "error").mockImplementation(() => {});
                deps.media.loadDiscImage.mockRejectedValue(new Error("HTTP 404"));
                await openWith([elite]);
                rows()[0].querySelector(".media-row-main").click();
                await vi.waitFor(() => expect(bay(0).querySelector(".bay-retry").hidden).toBe(false));
                expect(deps.media.setAutoboot).not.toHaveBeenCalled();
                expect(deps.processor.reset).not.toHaveBeenCalled();
            });

            it("boots a file opened this session, leaving autoboot out of a URL that cannot name it", async () => {
                deps.media.loadDiscImage.mockResolvedValue(discFor("mine.ssd", ssdImage()));
                urlState.set({ autoboot: true });
                await openWith([{ ...elite, ref: "session:mine.ssd", title: "mine.ssd", source: "session" }]);
                rows()[0].querySelector(".media-row-main").click();
                await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalled());
                expect(urlState.params.autoboot).toBeUndefined();
            });

            it.each([
                [false, true],
                [true, false],
            ])("retries a failed load (Shift %s) as it was asked for, booting %s", async (shiftKey, boots) => {
                vi.spyOn(console, "error").mockImplementation(() => {});
                deps.media.loadDiscImage.mockRejectedValueOnce(new Error("HTTP 404"));
                await openWith([elite]);
                const row = rows()[0].querySelector(".media-row-main");
                if (shiftKey) shiftClick(row);
                else row.click();
                await vi.waitFor(() => expect(bay(0).querySelector(".bay-retry").hidden).toBe(false));
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
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
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                await openWith([elite]);
                bay(0).querySelector(".bay-retry").click();
                await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
                expect(deps.autoboot).toHaveBeenCalledTimes(boots ? 1 : 0);
            });

            it.each([
                ["without autoboot", false],
                ["with autoboot", true],
            ])("fills drive 0 from Google Drive once connected for a link %s, booting %s", async (_, boots) => {
                if (boots) urlState.set({ autoboot: true });
                const mine = { ...elite, ref: "gd:abc/mine.ssd", title: "mine.ssd", source: "gdrive" };
                await failedStartupLoad("gd:abc/mine.ssd");
                deps.media.loadDiscImage.mockResolvedValue(discFor("mine.ssd", ssdImage()));
                await openWith([elite]);
                deps.media.listAll.mockResolvedValue({ descriptors: [elite, mine], failures: [] });
                document.getElementById("media-connect-drive").click();
                await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
                expect(deps.autoboot).toHaveBeenCalledTimes(boots ? 1 : 0);
            });

            it("describes Enter by the row it takes, not only by where the list is aimed", async () => {
                await openWith([elite, chuckie]);
                document.querySelector('#media-into [data-target="tape"]').click();
                [...document.querySelectorAll("#media-chips .media-chip")]
                    .find((chip) => text(chip) === "Discs")
                    .click();
                search("elite");
                expect(hint()).toEqual(["Enter boots from drive 0", "Shift+Enter loads without booting", "Esc closes"]);
                document.querySelector('#media-into [data-target="0"]').click();
                [...document.querySelectorAll("#media-chips .media-chip")]
                    .find((chip) => text(chip) === "Tapes")
                    .click();
                search("chuckie");
                expect(hint()).toEqual(["Enter loads into the deck", "Esc closes"]);
            });

            it("does not boot a blank disc made in this browser", async () => {
                deps.media.loadDiscImage.mockResolvedValue(discFor("blank.ssd", ssdImage()));
                urlState.set({ autoboot: true });
                await openWith();
                document.getElementById("media-new-disc").click();
                document.getElementById("media-new-disc-name").value = "blank";
                document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
                await vi.waitFor(() => expect(fdc.drives[0].disc).toBeTruthy());
                expect(deps.processor.reset).not.toHaveBeenCalled();
                expect(urlState.params.autoboot).toBeUndefined();
            });
        });

        describe("with Autoboot unticked", () => {
            beforeEach(() => (startTicked = false));

            it("says Enter only loads and Shift+Enter boots, and names a plain load as one", async () => {
                await openWith([elite]);
                expect(autobootTick().checked).toBe(false);
                expect(hint()).toEqual(["Enter loads into drive 0", "Shift+Enter loads and boots", "Esc closes"]);
                expect(rows()[0].querySelector(".media-row-main").title).toMatch(/^Load Elite.*into drive 0$/);
            });

            it("loads without booting on Enter or a click, taking autoboot out of the URL", async () => {
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                urlState.set({ autoboot: true });
                await openWith([elite]);
                pressEnter();
                await vi.waitFor(() => expect(fdc.drives[0].disc).toBeTruthy());
                expect(urlState.params.autoboot).toBeUndefined();
                made.open();
                rows()[0].querySelector(".media-row-main").click();
                await vi.waitFor(() => expect(deps.media.loadDiscImage).toHaveBeenCalledTimes(2));
                await vi.waitFor(() => expect(made.isOpen).toBe(false));
                expect(deps.processor.reset).not.toHaveBeenCalled();
            });

            it("boots on Shift+Enter and on a shift-click, and the URL says so", async () => {
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                await openWith([elite]);
                pressEnter(true);
                await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalledTimes(1));
                expect(urlState.params.autoboot).toBe(true);
                made.open();
                shiftClick(rows()[0].querySelector(".media-row-main"));
                await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalledTimes(2));
            });

            it("redraws the hint and the rows when ticked again", async () => {
                await openWith([elite]);
                setTick(true);
                expect(hint()).toContain("Enter boots from drive 0");
                expect(rows()[0].querySelector(".media-row-main").title).toMatch(/^Boot Elite/);
            });
        });

        it("notes a search once per opening, when the box first has something in it", async () => {
            const sent = sentEvents();
            const window = await openWith([elite]);
            const box = document.getElementById("media-search");
            for (const text of ["e", "el", ""]) {
                box.value = text;
                box.dispatchEvent(new Event("input"));
            }
            window.close();
            window.open();
            box.value = "x";
            box.dispatchEvent(new Event("input"));
            expect(sent("feature_used").filter(({ action }) => action === "search")).toHaveLength(2);
        });

        const tickAndShift = [
            [true, false],
            [true, true],
            [false, false],
            [false, true],
        ];

        it.each(tickAndShift)(
            "loads into drive 1 from the other drive's button without a boot, ticked %s, Shift %s",
            async (ticked, shiftKey) => {
                startTicked = ticked;
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                urlState.set({ autoboot: true });
                await openWith([elite]);
                const button = rows()[0].querySelector(".media-target");
                if (shiftKey) shiftClick(button);
                else button.click();
                await vi.waitFor(() => expect(fdc.drives[1].disc).toBeTruthy());
                expect(deps.autoboot).not.toHaveBeenCalled();
                expect(deps.processor.reset).not.toHaveBeenCalled();
                expect(urlState.params.autoboot).toBe(true);
            },
        );

        it.each(tickAndShift)(
            "loads into drive 1 without a boot on Enter aimed there, ticked %s, Shift %s",
            async (ticked, shiftKey) => {
                startTicked = ticked;
                deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
                await openWith([elite]);
                document.querySelector('#media-into [data-target="1"]').click();
                pressEnter(shiftKey);
                await vi.waitFor(() => expect(fdc.drives[1].disc).toBeTruthy());
                expect(fdc.drives[0].disc).toBeUndefined();
                expect(deps.processor.reset).not.toHaveBeenCalled();
                expect(deps.media.setAutoboot).not.toHaveBeenCalled();
            },
        );

        it.each(tickAndShift)("never boots a tape, ticked %s, Shift %s", async (ticked, shiftKey) => {
            startTicked = ticked;
            deps.media.loadTapeImage.mockResolvedValue({ name: "Chuckie.uef", position: 0 });
            await openWith([chuckie]);
            document.querySelector('#media-into [data-target="tape"]').click();
            expect(rows()[0].querySelector(".media-row-main").title).toMatch(/^Load Chuckie.*into the cassette deck$/);
            pressEnter(shiftKey);
            await vi.waitFor(() => expect(tapeInterface.tape).toBeTruthy());
            expect(deps.processor.reset).not.toHaveBeenCalled();
            expect(deps.media.setAutoboot).not.toHaveBeenCalled();
        });

        it("does not fill a drive from Google Drive while a load of the user's own is in flight", async () => {
            await failedStartupLoad("gd:abc/mine.ssd");
            const mine = { ...elite, ref: "gd:abc/mine.ssd", title: "mine.ssd", source: "gdrive" };
            let finishLoad;
            deps.media.loadDiscImage.mockReturnValueOnce(new Promise((resolve) => (finishLoad = resolve)));
            await openWith([elite]);
            rows()[0].querySelector(".media-row-main").click();
            deps.media.listAll.mockResolvedValue({ descriptors: [elite, mine], failures: [] });
            document.getElementById("media-connect-drive").click();
            await vi.waitFor(() => expect(rowTitles()).toContain("mine.ssd"));
            // The startup attempt and the user's own load; nothing more for Drive.
            expect(deps.media.loadDiscImage).toHaveBeenCalledTimes(2);
            finishLoad(discFor("A.ssd", ssdImage()));
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
            expect(urlState.params.disc1).toBe("hfe:A.hfe");
        });

        it("redraws the slots when a save state has been restored", async () => {
            const window = make();
            putDiscIn(0, discFor("a.ssd", ssdImage()));
            fdc.drives[0].tracksPerStep = 2;
            slots().restored();
            expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);
            expect(window.isOpen).toBe(false);
        });

        it("reads the autoboot tick once the disc has arrived, not before", async () => {
            let finishLoad;
            deps.media.loadDiscImage.mockReturnValueOnce(new Promise((resolve) => (finishLoad = resolve)));
            await openWith([elite]);
            rows()[0].querySelector(".media-row-main").click();
            setTick(false);
            finishLoad(discFor("A.ssd", ssdImage()));
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });

        it("lists a file opened while it is up, and leaves a closed window to list it on opening", async () => {
            const window = await openWith([elite]);
            const mine = { ...elite, ref: "session:mine.ssd", title: "mine.ssd", source: "session" };
            deps.media.listAll.mockResolvedValue({ descriptors: [elite, mine], failures: [] });
            deps.media.dispatchEvent(new Event("files-changed"));
            await vi.waitFor(() => expect(rowTitles()).toContain("mine.ssd"));
            window.close();
            deps.media.listAll.mockClear();
            deps.media.dispatchEvent(new Event("files-changed"));
            expect(deps.media.listAll).not.toHaveBeenCalled();
        });

        it("marks a file opened this session as in the slot that holds it", async () => {
            const mine = { ...elite, ref: "session:mine.ssd", title: "mine.ssd", source: "session" };
            await openWith([mine]);
            putDiscIn(1, discFor("mine.ssd", ssdImage()), "session:mine.ssd");
            expect(text(rows()[0].querySelector(".detail"))).toContain("in drive 1");
        });

        it("tells apart, to a screen reader too, two files opened under one name", async () => {
            await openWith([
                describeSessionFile("1/game.ssd", "game.ssd", "disc", { order: 1, count: 2 }),
                describeSessionFile("2/game.ssd", "game.ssd", "disc", { order: 2, count: 2 }),
            ]);
            const labels = rows().map((row) => row.querySelector(".media-row-main").getAttribute("aria-label"));
            expect(labels).toEqual([
                "Boot game.ssd, opened this session, 1st of 2, This session from drive 0",
                "Boot game.ssd, opened this session, 2nd of 2, This session from drive 0",
            ]);
        });

        it("shows a load in the bay while it happens, and a failure with Retry afterwards", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            let fail;
            deps.media.loadDiscImage.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
            await openWith([elite]);
            rows()[0].querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("busy"));
            expect(text(bay(0).querySelector(".bay-status"))).toBe("loading Elite from HFE archive…");
            fail(new Error("HTTP 404"));
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("empty"));
            expect(text(bay(0).querySelector(".bay-fail"))).toBe("could not load Elite: HTTP 404");
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(false);
            expect(urlState.params.disc1).toBeUndefined();
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            bay(0).querySelector(".bay-retry").click();
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(true);
        });

        it("clears a failure when a disc reaches the drive some other way", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.media.loadDiscImage.mockRejectedValue(new Error("HTTP 404"));
            await openWith([elite]);
            rows()[0].querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(bay(0).querySelector(".bay-retry").hidden).toBe(false));
            putDiscIn(0, discFor("dropped.ssd", ssdImage()));
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(true);
            expect(text(bay(0).querySelector(".bay-fail"))).toBe("");
        });

        it("shows a tape that could not be loaded on the deck, with Retry", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.media.loadTapeImage.mockRejectedValueOnce(new Error("offline"));
            await openWith([chuckie]);
            document.getElementById("deck-window").click();
            rows()[0].querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(document.getElementById("deck-retry").hidden).toBe(false));
            expect(text(document.getElementById("deck-fail"))).toBe("could not load Chuckie: offline");
            const loadedTape = { name: "Chuckie.uef", position: 0 };
            deps.media.loadTapeImage.mockResolvedValue(loadedTape);
            document.getElementById("deck-retry").click();
            await vi.waitFor(() => expect(tapeInterface.tape).toBe(loadedTape));
            expect(document.getElementById("deck-retry").hidden).toBe(true);
        });

        it("notes each load with the row it was picked from, naming the user's own media only by its source", async () => {
            const sent = sentEvents();
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            deps.media.loadTapeImage.mockResolvedValue({ name: "Mine.uef", position: 0 });
            const tape = { ...chuckie, ref: "session:1/Mine.uef", title: "Mine.uef", source: "session" };
            await openWith([saves, tape]);
            rows()[0].querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(sent("media_load")).toHaveLength(1));
            await openWith([saves, tape]);
            document.getElementById("deck-window").click();
            [...rows()]
                .find((row) => row.textContent.includes("Mine.uef"))
                .querySelector(".media-row-main")
                .click();
            await vi.waitFor(() => expect(sent("media_load")).toHaveLength(2));
            await openWith([saves, tape]);
            [...rows()]
                .find((row) => row.textContent.includes("saves.ssd"))
                .querySelector(".media-row-main")
                .click();
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
            document.getElementById("deck-window").click();
            expect(rows()[0].querySelector(".media-keycap").textContent).toBe("T");
            expect(rows()[0].querySelector(".media-target")).toBeNull();
            document.getElementById("deck-hide").click();
            expect(panel().classList.contains("deck-collapsed")).toBe(true);
            rows()[0].querySelector(".media-row-main").click();
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
            const input = document.getElementById("media-open");
            Object.defineProperty(input, "files", { value: [new File([new Uint8Array(4)], "mine.ssd")] });
            input.dispatchEvent(new Event("change"));
            await vi.waitFor(() => expect(deps.media.openFile).toHaveBeenCalledWith(expect.anything(), 1, "file"));
            expect(panel().hidden).toBe(true);
            document.getElementById("media-connect-drive").click();
            await vi.waitFor(() => expect(deps.driveSource.connect).toHaveBeenCalled());
            expect(deps.media.listAll).toHaveBeenCalledTimes(2);
        });

        it("fills a drive the URL names on Google Drive once Drive is connected, and stays open", async () => {
            const mine = { ...elite, ref: "gd:abc/mine.ssd", title: "mine.ssd", source: "gdrive" };
            const loaded = discFor("mine.ssd", ssdImage());
            await failedStartupLoad("gd:abc/mine.ssd");
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await openWith([elite]);
            deps.media.listAll.mockResolvedValue({ descriptors: [elite, mine], failures: [] });
            document.getElementById("media-connect-drive").click();
            await vi.waitFor(() => expect(fdc.drives[0].disc === loaded).toBe(true));
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("gd:abc/mine.ssd", "auto");
            expect(panel().hidden).toBe(false);
            expect(rowTitles()[0]).toBe("mine.ssd");
            expect(text(rows()[0].querySelector(".detail"))).toContain("in drive 0");
        });

        it("stays open, with no toast, when a save state could not be restored", async () => {
            let finishOpen;
            deps.media.openFile.mockReturnValue(new Promise((resolve) => (finishOpen = resolve)));
            await openWith([]);
            const input = document.getElementById("media-open");
            Object.defineProperty(input, "files", { value: [new File([new Uint8Array(4)], "bad.snp")] });
            input.dispatchEvent(new Event("change"));
            await vi.waitFor(() => expect(deps.media.openFile).toHaveBeenCalled());
            finishOpen(null);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(panel().hidden).toBe(false);
            expect(toasts()).toEqual([]);
        });

        it("leaves the window open when a file cannot be opened", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.media.openFile.mockRejectedValue(new Error("not a disc"));
            await openWith([]);
            const input = document.getElementById("media-open");
            Object.defineProperty(input, "files", { value: [new File([new Uint8Array(4)], "mine.txt")] });
            input.dispatchEvent(new Event("change"));
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
            expect(document.getElementById("media-count").textContent).toBe("");
            document.getElementById("media-connect-drive").click();
            await vi.waitFor(() => expect(rowTitles()).toEqual(["Elite"]));
            answerFirst({ descriptors: [stale], failures: [] });
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(rowTitles()).toEqual(["Elite"]);
        });

        it("caps the rows and says so, until the search narrows them", async () => {
            const many = Array.from({ length: 120 }, (_, i) => ({ ...elite, ref: `hfe:${i}.hfe`, title: `Disc ${i}` }));
            await openWith(many);
            expect(rows().length).toBe(100);
            expect(text(document.getElementById("media-count"))).toBe("showing 100 of 120; keep typing to narrow it");
            search("Disc 11");
            expect(text(document.getElementById("media-count"))).toBe("11 of 120");
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
        const row = () => document.querySelector("#media-list .media-row-main");
        const navigatedTo = () => urlState.navigatedTo;

        beforeEach(() => stubNavigation(urlState));

        it("switches machine without asking on a booting click, leaving word for the next page", async () => {
            await openWith([paradroid]);
            row().click();
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
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            const window = await openWith([paradroid]);
            const shiftClickRow = () => row().dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
            shiftClickRow();
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
            shiftClickRow();
            await vi.waitFor(() => expect(deps.media.loadDiscImage).toHaveBeenCalledWith(paradroid.ref, "auto"));
            await vi.waitFor(() => expect(window.isOpen).toBe(false));
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });

        it("switches without asking on a shift-click with Autoboot unticked", async () => {
            startTicked = false;
            await openWith([paradroid]);
            row().dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
            await vi.waitFor(() =>
                expect(navigatedTo()).toBe(
                    "https://bbc.example/?autoboot&disc1=bitshifters:bs-paradroid.ssd&model=Master",
                ),
            );
            expect(confirm).not.toHaveBeenCalled();
        });

        it("asks on a plain click with Autoboot unticked", async () => {
            startTicked = false;
            confirm.mockResolvedValue(false);
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            await openWith([paradroid]);
            row().click();
            await vi.waitFor(() => expect(deps.media.loadDiscImage).toHaveBeenCalledWith(paradroid.ref, "auto"));
            expect(confirm).toHaveBeenCalled();
        });

        it("asks for the other drive even with Autoboot ticked, since only drive 0 boots, and leaves the boot behind", async () => {
            urlState.set({ autoboot: true });
            confirm.mockResolvedValue(true);
            await openWith([paradroid]);
            document.querySelector("#media-list .media-target").click();
            await vi.waitFor(() =>
                expect(navigatedTo()).toBe("https://bbc.example/?disc2=bitshifters:bs-paradroid.ssd&model=Master"),
            );
        });
    });

    describe("the page as a drop zone", () => {
        const dragEvent = (type, target = document.body) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], dropEffect: "" } });
            target.dispatchEvent(event);
            return event;
        };
        const dropFile = (file) => {
            const event = new Event("drop", { bubbles: true, cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [file] } });
            document.body.dispatchEvent(event);
        };
        const zone = () => document.getElementById("drop-zone");

        it("shows where a file will go while one is over the page, and hides when it leaves", () => {
            make();
            expect(zone().hidden).toBe(true);
            dragEvent("dragenter");
            expect(zone().hidden).toBe(false);
            expect(text(zone())).toContain("a disc goes into drive 0");
            dragEvent("dragenter", document.getElementById("leds"));
            dragEvent("dragleave", document.getElementById("leds"));
            expect(zone().hidden).toBe(false);
            dragEvent("dragleave");
            expect(zone().hidden).toBe(true);
        });

        it("ignores a drag that carries no files", () => {
            make();
            const event = new Event("dragenter", { bubbles: true, cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
            document.body.dispatchEvent(event);
            expect(zone().hidden).toBe(true);
            expect(event.defaultPrevented).toBe(false);
        });

        it("opens a dropped file into the aimed drive and says so", async () => {
            deps.media.openFile.mockResolvedValue({
                kind: "disc",
                name: "mine.ssd",
                driveIndex: 1,
                words: "Loaded mine.ssd into drive 1.",
            });
            const window = await openWith([]);
            document.querySelector('#media-into [data-target="1"]').click();
            dragEvent("dragenter");
            dropFile(new File([new Uint8Array(4)], "mine.ssd"));
            await vi.waitFor(() => expect(deps.media.openFile).toHaveBeenCalledWith(expect.anything(), 1, "drop"));
            await vi.waitFor(() =>
                expect(toasts()).toEqual([expect.stringContaining("Loaded mine.ssd into drive 1.")]),
            );
            expect(zone().hidden).toBe(true);
            expect(window.isOpen).toBe(false);
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });

        it("boots a disc dropped into drive 0 when Autoboot is ticked", async () => {
            deps.media.openFile.mockResolvedValue({
                kind: "disc",
                name: "game.ssd",
                ref: "session:1/game.ssd",
                driveIndex: 0,
                words: "Loaded game.ssd into drive 0.",
            });
            make();
            dropFile(new File([new Uint8Array(4)], "game.ssd"));
            await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalled());
            expect(deps.processor.reset).toHaveBeenCalledWith(true);
        });

        it("does not boot a disc dropped into drive 0 when Autoboot is unticked", async () => {
            startTicked = false;
            deps.media.openFile.mockResolvedValue({
                kind: "disc",
                name: "game.ssd",
                ref: "session:1/game.ssd",
                driveIndex: 0,
                words: "Loaded game.ssd into drive 0.",
            });
            make();
            dropFile(new File([new Uint8Array(4)], "game.ssd"));
            await vi.waitFor(() => expect(toasts()).toHaveLength(1));
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });

        it("does not boot a tape or a restored state, whatever the tick says", async () => {
            deps.media.openFile.mockResolvedValue({ kind: "tape", name: "t.uef", words: "Loaded t.uef as the tape." });
            make();
            dropFile(new File([new Uint8Array(4)], "t.uef"));
            await vi.waitFor(() => expect(toasts()).toHaveLength(1));
            expect(deps.processor.reset).not.toHaveBeenCalled();
        });

        it("reports a file that could not be opened", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.media.openFile.mockRejectedValue(new Error("not a disc"));
            make();
            dropFile(new File([new Uint8Array(4)], "junk.bin"));
            await vi.waitFor(() => expect(toasts()).toEqual([expect.stringContaining("not a disc")]));
        });
    });

    describe("the footer", () => {
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
            deps.driveSource.createBlank.mockResolvedValue({ ref: "gd:x/a.ssd", disc: discFor("a.ssd", ssdImage()) });
            await openWith();
            const where = (value) => document.querySelector(`#media-new-disc-where input[value="${value}"]`);
            document.getElementById("media-new-disc").click();
            where("gdrive").checked = true;
            document.getElementById("media-new-disc-name").value = "a.ssd";
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(deps.driveSource.createBlank).toHaveBeenCalled());
            document.getElementById("media-new-disc").click();
            expect(where("browser").checked).toBe(true);
        });

        it("makes a blank disc in this browser under the typed name, in the aimed drive", async () => {
            deps.media.loadDiscImage.mockResolvedValue(discFor("mine.ssd", ssdImage()));
            await openWith();
            document.querySelector('#media-into [data-target="1"]').click();
            document.getElementById("media-new-disc").click();
            expect(document.getElementById("media-new-disc-form").hidden).toBe(false);
            expect(document.getElementById("media-new-disc-drive-option").hidden).toBe(true);
            document.getElementById("media-new-disc-name").value = "mine.hfe";
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(deps.media.loadDiscImage).toHaveBeenCalledWith("local:mine.ssd", "auto"));
            await vi.waitFor(() => expect(fdc.drives[1].disc).toBeTruthy());
            expect(urlState.params.disc2).toBe("local:mine.ssd");
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
        });

        it("makes a blank disc on Google Drive once connected", async () => {
            deps.driveSource.connected = true;
            const created = discFor("fresh.ssd", ssdImage());
            deps.driveSource.createBlank.mockResolvedValue({ ref: "gd:xyz/fresh.ssd", disc: created });
            urlState.set({ autoboot: true });
            await openWith();
            expect(document.getElementById("media-connect-drive").hidden).toBe(true);
            document.getElementById("media-new-disc").click();
            document.getElementById("media-new-disc-name").value = "fresh.ssd";
            document.querySelector('#media-new-disc-where input[value="gdrive"]').checked = true;
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(fdc.drives[0].disc === created).toBe(true));
            expect(deps.driveSource.createBlank).toHaveBeenCalledWith("fresh.ssd", "auto");
            expect(urlState.params.disc1).toBe("gd:xyz/fresh.ssd");
            expect(panel().hidden).toBe(true);
            expect(deps.processor.reset).not.toHaveBeenCalled();
            expect(urlState.params.autoboot).toBeUndefined();
        });

        it("leaves the drive empty, with nothing to retry, when Google Drive cannot make the disc", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.driveSource.connected = true;
            deps.driveSource.createBlank.mockRejectedValue(new Error("quota"));
            await openWith();
            document.getElementById("media-new-disc").click();
            document.getElementById("media-new-disc-name").value = "fresh.ssd";
            document.querySelector('#media-new-disc-where input[value="gdrive"]').checked = true;
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("busy"));
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("empty"));
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(true);
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
            expect(panel().hidden).toBe(false);
        });

        it("copies the disc in a drive to Google Drive from its Save menu", async () => {
            deps.driveSource.connected = true;
            const copy = discFor("mine.ssd", ssdImage());
            deps.driveSource.createFrom.mockResolvedValue({ ref: "gd:xyz/mine.ssd", disc: copy });
            putDiscIn(1, discFor("Superior/Exile.ssd", ssdImage()));
            await openWith();
            bay(1).querySelector(".bay-save-drive").click();
            expect(document.getElementById("media-new-disc-form").hidden).toBe(false);
            expect(document.getElementById("media-new-disc-where").hidden).toBe(true);
            expect(document.getElementById("media-new-disc-name").value).toBe("Exile.ssd");
            expect(text(document.getElementById("media-new-disc-label"))).toContain("drive 1");
            document.getElementById("media-new-disc-name").value = "mine.ssd";
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(fdc.drives[1].disc === copy).toBe(true));
            const [name, data, layout] = deps.driveSource.createFrom.mock.calls[0];
            expect(name).toBe("mine.ssd");
            expect(data.length).toBeGreaterThan(0);
            expect(layout).toBe("auto");
            expect(urlState.params.disc2).toBe("gd:xyz/mine.ssd");
        });

        it("connects Google Drive first when the Save menu asks for a copy there", async () => {
            deps.driveSource.connect.mockResolvedValue(false);
            putDiscIn(0, discFor("a.ssd", ssdImage()));
            await openWith();
            bay(0).querySelector(".bay-save-drive").click();
            await vi.waitFor(() => expect(deps.driveSource.connect).toHaveBeenCalled());
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
        });

        it("puts the new disc form away when the window closes", async () => {
            const window = await openWith();
            document.getElementById("media-new-disc").click();
            window.close();
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
        });

        it("cancels the new disc form back to the search box", async () => {
            await openWith();
            document.getElementById("media-new-disc").click();
            document.getElementById("media-new-disc-cancel").click();
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
        });
    });

    describe("on the Atom, which has no drives", () => {
        beforeEach(() => {
            deps.model.isAtom = true;
            deps.processor.fdc = undefined;
        });

        it("shows only the deck, and aims at it however it is opened", () => {
            const window = make();
            expect(document.querySelector("#media-panel .media-case").hidden).toBe(true);
            expect(document.querySelector('#media-into [data-target="0"]').hidden).toBe(true);
            expect(document.querySelector('#media-into [data-target="tape"]').hidden).toBe(false);
            window.open();
            expect(document.getElementById("deck-window").classList.contains("target")).toBe(true);
            window.close();
            window.openFor(0);
            expect(document.getElementById("deck-window").classList.contains("target")).toBe(true);
            expect(document.getElementById("media-search").placeholder).toBe("Search for a tape for the deck");
        });

        it("offers no discs, whatever the sources list", async () => {
            const row = (kind, title) => ({
                ref: `sth:${title}.zip`,
                kind,
                title,
                publisher: "",
                detail: "",
                source: "sth",
            });
            await openWith([row("disc", "Elite"), row("tape", "Chuckie")]);
            const titles = [...document.querySelectorAll("#media-list .media-row .title")].map((t) => t.textContent);
            expect(titles).toEqual(["Chuckie"]);
            const chips = [...document.querySelectorAll("#media-chips .media-chip")].map((c) => c.textContent);
            expect(chips).not.toContain("Discs");
        });
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
                descriptors: [
                    {
                        ref: "hfe:3A1DAB83.hfe",
                        kind: "disc",
                        title: "Calligraphy",
                        publisher: "",
                        detail: "",
                        source: "hfe",
                    },
                ],
                failures: [],
            });
            const window = make();
            putDiscIn(0, discFor("3A1DAB83.hfe", toHfe(discFor("x.ssd", ssdImage()))), "hfe:3A1DAB83.hfe");
            expect(text(bay(0).querySelector(".bay-title"))).toBe("3A1DAB83.hfe");
            window.open();
            await vi.waitFor(() => expect(text(bay(0).querySelector(".bay-title"))).toBe("Calligraphy"));
            expect(readout("0")).toBe("Calligraphy");
        });
    });

    describe("naming where a reference came from", () => {
        it("knows every schema the URL takes", () => {
            expect(sourceOf("sth:Games/ELITE.zip")).toBe("STH archive");
            expect(sourceOf("|Games/ELITE.zip")).toBe("STH archive");
            expect(sourceOf("hfe:3A1DAB83.hfe")).toBe("HFE archive");
            expect(sourceOf("bitshifters:bs-paradroid.ssd")).toBe("Bitshifters");
            expect(sourceOf("github:mattgodbolt/nm/ninja_music.ssd")).toBe("GitHub");
            expect(sourceOf("gd:abc/mine.ssd")).toBe("Google Drive");
            expect(sourceOf("local:mine")).toBe("this browser");
            expect(sourceOf("!mine")).toBe("this browser");
            expect(sourceOf("https://example.com/a.ssd")).toBe("the web");
            expect(sourceOf("elite.ssd")).toBe("built in");
            expect(sourceOf("session:mine.ssd")).toBe("a file opened this session");
            expect(sourceOf(undefined)).toBeNull();
        });

        it("has words for every schema a reference can take", () => {
            for (const schema of Object.keys(Schemas)) {
                const ref = schema === "" ? "x.ssd" : schema.length === 1 ? `${schema}x.ssd` : `${schema}:x.ssd`;
                expect(sourceOf(ref), schema).toBeTruthy();
            }
        });
    });
});

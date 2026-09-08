// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaWindow, shortName, sourceOf } from "../../src/web/media-window.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
import { toHfe } from "../../src/disc-hfe.js";
import { domFromIndexHtml, fakeUrlState, ssdImage, teardownDom } from "./helpers.js";

/** An SSD whose catalogue carries a title and cycle number. */
function titledImage(title, cycle) {
    const data = ssdImage();
    data.set(new TextEncoder().encode(title.slice(0, 8)), 0);
    data.set(new TextEncoder().encode(title.slice(8, 12)), 0x100);
    data[0x104] = cycle;
    return data;
}

function fakeFdc() {
    const drives = [
        { tracksPerStep: 1, disc: undefined },
        { tracksPerStep: 1, disc: undefined },
    ];
    return {
        drives,
        motorOn: [false, false],
        loadDisc: (driveIndex, disc, fixed) => {
            drives[driveIndex].disc = disc;
            drives[driveIndex].tracksPerStep = fixed ?? (disc?.is40Track ? 2 : 1);
        },
    };
}

describe("MediaWindow", () => {
    let deps;
    let fdc;
    let tapeInterface;
    let loop;

    beforeEach(() => {
        domFromIndexHtml("navbarSupportedContent", "leds", "media-panel", "drive-bay-template");
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
            playTape: vi.fn(),
            stopTape: vi.fn(),
            pressPlay: vi.fn(() => (tapeInterface.playPressed = true)),
            pressStop: vi.fn(() => (tapeInterface.playPressed = false)),
        };
        loop = new EventTarget();
        const drives = new Drives({
            fdc,
            driveTracks: [DriveTracks.auto, DriveTracks.auto],
            confirm: vi.fn(),
            urlState: fakeUrlState(),
        });
        const media = new EventTarget();
        Object.assign(media, {
            params: {},
            listAll: vi.fn().mockResolvedValue({ descriptors: [], failures: [] }),
            loadDiscImage: vi.fn(),
            loadTapeImage: vi.fn(),
            setDiscImage: vi.fn((driveIndex, name) => {
                media.params[driveIndex === 0 ? "disc1" : "disc2"] = name;
                media.dispatchEvent(new CustomEvent("media-changed", { detail: {} }));
            }),
            setTapeImage: vi.fn((name) => (media.params.tape = name)),
            setProcessorTape: vi.fn((tape) => {
                tapeInterface.tape = tape;
                media.dispatchEvent(new CustomEvent("tape-changed", { detail: { tape } }));
            }),
            openFile: vi.fn(),
            setAutoboot: vi.fn((on) => {
                if (on) media.params.autoboot = "";
                else delete media.params.autoboot;
            }),
            ejectDisc: vi.fn((driveIndex) => drives.eject(driveIndex)),
            ejectTape: vi.fn(() => {
                tapeInterface.tape = undefined;
                media.dispatchEvent(new CustomEvent("tape-changed", { detail: { tape: undefined } }));
            }),
        });
        deps = {
            media,
            drives,
            processor: { fdc, tapeInterface, atomppia: tapeInterface, reset: vi.fn() },
            model: { isAtom: false },
            loop,
            visualiser: { openOn: vi.fn() },
            autoboot: vi.fn(),
            googleDrive: { connect: vi.fn().mockResolvedValue(true), connected: false, createBlank: vi.fn() },
        };
    });

    afterEach(teardownDom);

    const make = () => new MediaWindow(deps);
    const panel = () => document.getElementById("media-panel");
    const bay = (driveIndex) => document.querySelector(`.bay[data-drive="${driveIndex}"]`);
    const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
    const readout = (slot) => text(document.querySelector(`#leds .slot-readout[data-slot="${slot}"] .line`));
    const putTapeIn = (tape) => {
        tapeInterface.tape = tape;
        deps.media.dispatchEvent(new CustomEvent("tape-changed", { detail: { tape } }));
    };
    const tick = () => loop.dispatchEvent(new Event("tick"));

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

        it("aims the list at the slot whose line in the LED panel was clicked", () => {
            make();
            document.querySelector('#leds .slot-readout[data-slot="1"]').click();
            expect(bay(1).classList.contains("target")).toBe(true);
            document.querySelector('#leds .slot-readout[data-slot="tape"]').click();
            expect(document.getElementById("deck-window").classList.contains("target")).toBe(true);
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
            deps.media.params.disc2 = "sth:Games/ELITE.zip";
            deps.drives.putDiscIn(1, discFor("ELITE.ssd", titledImage("ELITE", 0x04)));
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

        it("hides the sticker when the catalogue is blank", () => {
            make();
            deps.drives.putDiscIn(0, discFor("blank.ssd", ssdImage()));
            expect(bay(0).querySelector(".bay-dfs").hidden).toBe(true);
        });

        it("follows a 40 track disc onto the switch, and moves the switch from the radios", () => {
            make();
            deps.drives.putDiscIn(0, discFor("forty.ssd", ssdImage(400)));
            expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);
            const eighty = bay(0).querySelector('input[value="80"]');
            eighty.checked = true;
            eighty.dispatchEvent(new Event("change"));
            expect(fdc.drives[0].tracksPerStep).toBe(1);
            expect(text(bay(0).querySelector(".bay-status"))).toContain("80T");
        });

        it("throws the switch the other way when its track is clicked", () => {
            make();
            deps.drives.putDiscIn(0, discFor("a.ssd", ssdImage()));
            bay(0).querySelector(".pitch .track").click();
            expect(fdc.drives[0].tracksPerStep).toBe(2);
            expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);
            bay(0).querySelector(".pitch .track").click();
            expect(fdc.drives[0].tracksPerStep).toBe(1);
        });

        it("ejects from the latch", () => {
            make();
            deps.drives.putDiscIn(0, discFor("a.ssd", ssdImage()));
            bay(0).querySelector(".bay-eject").click();
            expect(deps.media.ejectDisc).toHaveBeenCalledWith(0);
            expect(bay(0).dataset.state).toBe("empty");
            expect(readout("0")).toBe("empty");
        });

        it("saves through the drives and opens the surface on its own drive", () => {
            make();
            deps.drives.putDiscIn(1, discFor("a.ssd", ssdImage()));
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
            vi.advanceTimersByTime(2500);
            expect(box.classList.contains("attention")).toBe(false);
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
            deps.media.params.tape = "sth:Games/Chuckie.zip";
            putTapeIn(tape(0.5));
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

        it("plays and stops the Atom's tape from the keys", () => {
            deps.model.isAtom = true;
            make();
            putTapeIn(tape());
            document.getElementById("tape-play").click();
            expect(tapeInterface.playTape).toHaveBeenCalled();
            tapeInterface.motorOn = true;
            tick();
            expect(document.getElementById("tape-play").disabled).toBe(true);
            document.getElementById("tape-stop").click();
            expect(tapeInterface.stopTape).toHaveBeenCalled();
        });

        it("rewinds and ejects from the keys", () => {
            make();
            putTapeIn(tape());
            document.getElementById("tape-rewind").click();
            expect(tapeInterface.rewindTape).toHaveBeenCalled();
            document.getElementById("tape-eject").click();
            expect(deps.media.ejectTape).toHaveBeenCalled();
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
            deps.media.ejectTape();
            expect(document.getElementById("deck-hide").hidden).toBe(false);
        });

        it("starts unfolded on an Atom", () => {
            deps.model.isAtom = true;
            make();
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
        });
    });

    describe("folding", () => {
        it("keeps drive 1 folded until a disc goes in it, it is aimed at, or its bar is clicked", () => {
            make();
            expect(bay(1).classList.contains("folded")).toBe(true);
            expect(text(bay(1).querySelector(".bay-bar-name"))).toBe("empty");
            bay(1).querySelector(".bay-bar").click();
            expect(bay(1).classList.contains("folded")).toBe(false);
            const window = make();
            document.querySelector('#media-into [data-target="1"]').click();
            expect(bay(1).classList.contains("folded")).toBe(false);
            window.showDrive(false);
            deps.drives.putDiscIn(1, discFor("b.ssd", ssdImage()));
            expect(bay(1).classList.contains("folded")).toBe(false);
            expect(text(bay(1).querySelector(".bay-bar-name"))).toBe("b.ssd");
        });

        it("opens with the list whichever way it is opened, and the list folds and unfolds on request", () => {
            deps.drives.putDiscIn(0, discFor("a.ssd", ssdImage()));
            const window = make();
            document.querySelector('#leds .slot-readout[data-slot="0"]').click();
            expect(window.isOpen).toBe(true);
            expect(panel().classList.contains("list-collapsed")).toBe(false);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
            document.getElementById("list-hide").click();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            document.getElementById("list-toggle").click();
            expect(panel().classList.contains("list-collapsed")).toBe(false);
            window.close();
            document.querySelector('#leds .slot-readout[data-slot="1"]').click();
            expect(bay(1).classList.contains("target")).toBe(true);
            expect(bay(1).classList.contains("folded")).toBe(false);
        });

        it("lets drive 1 fold away again once it is empty, but not while it holds a disc", () => {
            make();
            bay(1).querySelector(".bay-bar").click();
            expect(bay(1).querySelector(".bay-hide").hidden).toBe(false);
            bay(1).querySelector(".bay-hide").click();
            expect(bay(1).classList.contains("folded")).toBe(true);
            deps.drives.putDiscIn(1, discFor("b.ssd", ssdImage()));
            expect(bay(1).classList.contains("folded")).toBe(false);
            expect(bay(1).querySelector(".bay-hide").hidden).toBe(true);
            expect(bay(0).querySelector(".bay-hide").hidden).toBe(true);
        });

        it("lets the latch of an empty drive aim the list at it, unfolding the list", () => {
            deps.drives.putDiscIn(0, discFor("a.ssd", ssdImage()));
            make();
            document.querySelector('#leds .slot-readout[data-slot="0"]').click();
            document.getElementById("list-hide").click();
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            bay(0).querySelector(".bay-eject").click();
            expect(deps.media.ejectDisc).toHaveBeenCalledWith(0);
            expect(panel().classList.contains("list-collapsed")).toBe(true);
            deps.media.ejectDisc.mockClear();
            bay(0).querySelector(".bay-eject").click();
            expect(panel().classList.contains("list-collapsed")).toBe(false);
            expect(deps.media.ejectDisc).not.toHaveBeenCalled();
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
        const openWith = async (descriptors, failures = []) => {
            deps.media.listAll.mockResolvedValue({ descriptors, failures });
            const window = make();
            window.open();
            await vi.waitFor(() => expect(deps.media.listAll).toHaveBeenCalled());
            await vi.waitFor(() => expect(document.getElementById("media-count").textContent).not.toBe(""));
            return window;
        };
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

        it("says which sources could not be listed", async () => {
            await openWith([elite], ["sth: offline"]);
            expect(text(document.querySelector("#media-list .notice"))).toBe("Could not list sth: offline");
        });

        it("loads a disc into the aimed drive from the row, and the other drive from its button", async () => {
            const loaded = discFor("A.ssd", ssdImage());
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await openWith([elite]);
            expect(rows()[0].querySelector(".media-row-main").title).toBe(
                "Load Elite, Acornsoft, D1S1 · 40 · v1, HFE archive into drive 0",
            );
            rows()[0].querySelector(".media-target").click();
            await vi.waitFor(() => expect(fdc.drives[1].disc).toBe(loaded));
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("hfe:A.hfe", "auto");
            expect(deps.media.setDiscImage).toHaveBeenCalledWith(1, "hfe:A.hfe");
            expect(deps.processor.reset).not.toHaveBeenCalled();
            expect(panel().hidden).toBe(true);
            await vi.waitFor(() => expect(text(rows()[0].querySelector(".detail"))).toContain("in drive 1"));
            bay(1).querySelector(".bay-slot").click();
            expect(text(document.getElementById("media-open-text"))).toBe("Open a file into drive 1…");
            expect(rows()[0].querySelector(".media-keycap").textContent).toBe("1");
            expect(rows()[0].querySelector(".media-target").textContent).toBe("0");
        });

        it("is aimed from the Into control, which says where the list points", async () => {
            await openWith([elite]);
            const into = (target) => document.querySelector(`#media-into [data-target="${target}"]`);
            expect(into("0").classList.contains("active")).toBe(true);
            into("1").click();
            expect(into("1").classList.contains("active")).toBe(true);
            expect(into("0").classList.contains("active")).toBe(false);
            expect(bay(1).classList.contains("target")).toBe(true);
            expect(document.getElementById("media-search").placeholder).toBe("Search for a disc for drive 1");
            expect(text(document.getElementById("media-hint"))).toContain("Enter loads into drive 1");
            into("tape").click();
            expect(document.getElementById("deck-window").classList.contains("target")).toBe(true);
            expect(document.getElementById("media-search").placeholder).toBe("Search for a tape for the deck");
        });

        it("boots the disc on Shift+Enter or a shift-click, whatever the autoboot tick says", async () => {
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            await openWith([elite]);
            const box = document.getElementById("media-search");
            box.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
            );
            await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalledWith("Elite"));
            expect(deps.processor.reset).toHaveBeenCalledWith(true);
            deps.autoboot.mockClear();
            make();
            await openWith([elite]);
            rows()[0]
                .querySelector(".media-row-main")
                .dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
            await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalledWith("Elite"));
        });

        it("resets and boots when autoboot is ticked and the disc goes into drive 0", async () => {
            deps.media.params.autoboot = "";
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            await openWith([elite]);
            rows()[0].querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(deps.autoboot).toHaveBeenCalledWith("Elite"));
            expect(deps.processor.reset).toHaveBeenCalledWith(true);
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
            expect(deps.media.setDiscImage).not.toHaveBeenCalled();
            deps.media.loadDiscImage.mockResolvedValue(discFor("A.ssd", ssdImage()));
            bay(0).querySelector(".bay-retry").click();
            await vi.waitFor(() => expect(bay(0).dataset.state).toBe("loaded"));
            expect(bay(0).querySelector(".bay-retry").hidden).toBe(true);
        });

        it("loads a tape into the deck from its row, unfolding the deck", async () => {
            const loadedTape = { name: "Chuckie.uef", position: 0 };
            deps.media.loadTapeImage.mockResolvedValue(loadedTape);
            await openWith([chuckie]);
            document.getElementById("deck-window").click();
            expect(rows()[0].querySelector(".media-keycap").textContent).toBe("T");
            expect(rows()[0].querySelector(".media-target")).toBeNull();
            rows()[0].querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(deps.media.setProcessorTape).toHaveBeenCalledWith(loadedTape));
            expect(deps.media.setTapeImage).toHaveBeenCalledWith("sth:AnF/Chuckie.zip");
            expect(panel().classList.contains("deck-collapsed")).toBe(false);
            expect(panel().hidden).toBe(true);
        });

        it("leaves a file opened this session out of the URL", async () => {
            deps.media.loadDiscImage.mockResolvedValue(discFor("mine.ssd", ssdImage()));
            await openWith([{ ...elite, ref: "session:mine.ssd", title: "mine.ssd", source: "session" }]);
            rows()[0].querySelector(".media-row-main").click();
            await vi.waitFor(() => expect(deps.media.setDiscImage).toHaveBeenCalledWith(0, undefined));
        });

        it("opens a file into the aimed drive from the footer, and connects Google Drive", async () => {
            deps.media.openFile.mockResolvedValue("Loaded mine.ssd into drive 1.");
            await openWith([]);
            bay(1).querySelector(".bay-slot").click();
            const input = document.getElementById("media-open");
            Object.defineProperty(input, "files", { value: [new File([new Uint8Array(4)], "mine.ssd")] });
            input.dispatchEvent(new Event("change"));
            await vi.waitFor(() => expect(deps.media.openFile).toHaveBeenCalledWith(expect.anything(), 1));
            expect(panel().hidden).toBe(true);
            document.getElementById("media-connect-drive").click();
            await vi.waitFor(() => expect(deps.googleDrive.connect).toHaveBeenCalled());
            expect(deps.media.listAll.mock.calls.length).toBeGreaterThanOrEqual(2);
        });
    });

    describe("the footer", () => {
        const openIt = async () => {
            const window = make();
            window.open();
            await vi.waitFor(() => expect(deps.media.listAll).toHaveBeenCalled());
            return window;
        };

        it("ticks and clears autoboot in the URL, and shows what was set elsewhere", async () => {
            await openIt();
            const tick = document.querySelector("#media-panel .autoboot");
            expect(tick.checked).toBe(false);
            tick.checked = true;
            tick.dispatchEvent(new Event("change"));
            expect(deps.media.setAutoboot).toHaveBeenCalledWith(true);
            tick.checked = false;
            tick.dispatchEvent(new Event("change"));
            expect(deps.media.setAutoboot).toHaveBeenCalledWith(false);
        });

        it("makes a blank disc in this browser under the typed name, in the aimed drive", async () => {
            deps.media.loadDiscImage.mockResolvedValue(discFor("mine.ssd", ssdImage()));
            await openIt();
            document.querySelector('#media-into [data-target="1"]').click();
            document.getElementById("media-new-disc").click();
            expect(document.getElementById("media-new-disc-form").hidden).toBe(false);
            expect(document.getElementById("media-new-disc-drive-option").hidden).toBe(true);
            document.getElementById("media-new-disc-name").value = "mine";
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(deps.media.loadDiscImage).toHaveBeenCalledWith("local:mine.ssd", "auto"));
            await vi.waitFor(() => expect(fdc.drives[1].disc).toBeTruthy());
            expect(deps.media.setDiscImage).toHaveBeenCalledWith(1, "local:mine.ssd");
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
        });

        it("makes a blank disc on Google Drive once connected", async () => {
            deps.googleDrive.connected = true;
            const created = discFor("fresh.ssd", ssdImage());
            deps.googleDrive.createBlank.mockResolvedValue({ ref: "gd:xyz/fresh.ssd", disc: created });
            await openIt();
            expect(document.getElementById("media-connect-drive").hidden).toBe(true);
            document.getElementById("media-new-disc").click();
            document.getElementById("media-new-disc-name").value = "fresh.ssd";
            document.querySelector('#media-new-disc-where input[value="gdrive"]').checked = true;
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(fdc.drives[0].disc).toBe(created));
            expect(deps.googleDrive.createBlank).toHaveBeenCalledWith("fresh.ssd", "auto");
            expect(deps.media.setDiscImage).toHaveBeenCalledWith(0, "gd:xyz/fresh.ssd");
            expect(panel().hidden).toBe(true);
        });

        it("copies the disc in a drive to Google Drive from its Save menu", async () => {
            deps.googleDrive.connected = true;
            deps.googleDrive.createFrom = vi.fn();
            const copy = discFor("mine.ssd", ssdImage());
            deps.googleDrive.createFrom.mockResolvedValue({ ref: "gd:xyz/mine.ssd", disc: copy });
            deps.drives.putDiscIn(1, discFor("Superior/Exile.ssd", ssdImage()));
            await openIt();
            bay(1).querySelector(".bay-save-drive").click();
            expect(document.getElementById("media-new-disc-form").hidden).toBe(false);
            expect(document.getElementById("media-new-disc-where").hidden).toBe(true);
            expect(document.getElementById("media-new-disc-name").value).toBe("Exile.ssd");
            expect(text(document.getElementById("media-new-disc-label"))).toContain("drive 1");
            document.getElementById("media-new-disc-name").value = "mine.ssd";
            document.getElementById("media-new-disc-form").dispatchEvent(new Event("submit", { cancelable: true }));
            await vi.waitFor(() => expect(fdc.drives[1].disc).toBe(copy));
            const [name, data, layout] = deps.googleDrive.createFrom.mock.calls[0];
            expect(name).toBe("mine.ssd");
            expect(data.length).toBeGreaterThan(0);
            expect(layout).toBe("auto");
            expect(deps.media.setDiscImage).toHaveBeenCalledWith(1, "gd:xyz/mine.ssd");
        });

        it("connects Google Drive first when the Save menu asks for a copy there", async () => {
            deps.googleDrive.connect.mockResolvedValue(false);
            deps.drives.putDiscIn(0, discFor("a.ssd", ssdImage()));
            await openIt();
            bay(0).querySelector(".bay-save-drive").click();
            await vi.waitFor(() => expect(deps.googleDrive.connect).toHaveBeenCalled());
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
        });

        it("cancels the new disc form back to the search box", async () => {
            await openIt();
            document.getElementById("media-new-disc").click();
            document.getElementById("media-new-disc-cancel").click();
            expect(document.getElementById("media-new-disc-form").hidden).toBe(true);
            expect(document.activeElement).toBe(document.getElementById("media-search"));
        });
    });

    describe("what fits on a line of the LED panel", () => {
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
            deps.media.params.disc1 = "hfe:3A1DAB83.hfe";
            deps.drives.putDiscIn(0, discFor("3A1DAB83.hfe", toHfe(discFor("x.ssd", ssdImage()))));
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
            expect(sourceOf("gd:abc/mine.ssd")).toBe("Google Drive");
            expect(sourceOf("local:mine")).toBe("this browser");
            expect(sourceOf("!mine")).toBe("this browser");
            expect(sourceOf("https://example.com/a.ssd")).toBe("the web");
            expect(sourceOf("elite.ssd")).toBe("built in");
            expect(sourceOf(undefined)).toBeNull();
        });
    });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaWindow, sourceOf } from "../../src/web/media-window.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
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
        tapeInterface = { tape: undefined, motorOn: false, rewindTape: vi.fn(), playTape: vi.fn(), stopTape: vi.fn() };
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
            ejectDisc: vi.fn((driveIndex) => drives.eject(driveIndex)),
            ejectTape: vi.fn(() => {
                tapeInterface.tape = undefined;
                media.dispatchEvent(new CustomEvent("tape-changed", { detail: { tape: undefined } }));
            }),
        });
        deps = {
            media,
            drives,
            processor: { fdc, tapeInterface, atomppia: tapeInterface },
            model: { isAtom: false },
            modals: { show: vi.fn() },
            loop,
            visualiser: { openOn: vi.fn() },
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
            document.querySelector("#navbarDiscs + .dropdown-menu .media-window-open").click();
            expect(window.isOpen).toBe(true);
            document.getElementById("media-close").click();
            expect(window.isOpen).toBe(false);
            document.querySelector('#leds .slot-readout[data-slot="tape"]').click();
            expect(panel().hidden).toBe(false);
        });
    });

    describe("a drive bay", () => {
        it("starts empty, with the latch open and nothing to save or eject", () => {
            make();
            expect(bay(0).dataset.state).toBe("empty");
            expect(bay(0).querySelector(".bay-eject").disabled).toBe(true);
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
            expect(readout("1")).toBe("ELITE.ssd");
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

        it("offers the disc list from the slot", () => {
            make();
            bay(0).querySelector(".bay-slot").click();
            expect(deps.modals.show).toHaveBeenCalledWith("discs");
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
            expect(text(document.getElementById("deck-status"))).toBe("chuckie.uef · STH archive · stopped");
            expect(text(document.getElementById("tape-counter"))).toBe("499");
            expect(readout("tape")).toBe("chuckie.uef499");
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

        it("keeps play latched on a BBC, which switches the motor itself", () => {
            make();
            putTapeIn(tape());
            expect(document.getElementById("tape-play").disabled).toBe(true);
            expect(document.getElementById("tape-play").title).toContain("*MOTOR");
            expect(document.getElementById("tape-stop").disabled).toBe(true);
            expect(document.getElementById("tape-rewind").disabled).toBe(false);
        });

        it("plays and stops the Atom's tape from the keys", () => {
            deps.model.isAtom = true;
            make();
            putTapeIn(tape());
            document.getElementById("tape-play").click();
            expect(tapeInterface.playTape).toHaveBeenCalled();
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

        it("offers the tape list from the window", () => {
            make();
            document.getElementById("deck-window").click();
            expect(deps.modals.show).toHaveBeenCalledWith("tapes");
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

// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaLoader } from "../../src/web/media-loader.js";
import { SnapshotUI, snapshotMedia } from "../../src/web/snapshot-ui.js";
import { createSnapshot, snapshotToJSON } from "../../src/snapshot.js";
import { MediaWindow } from "../../src/web/media-window.js";
import { Drives } from "../../src/web/drives.js";
import { describeRef } from "../../src/web/media-catalogue.js";
import { DriveTracks } from "../../src/url-params.js";
import { TestMachine } from "../../src/test-machine.js";
import { domFromIndexHtml, fakeUrlState, teardownDom } from "../unit/helpers.js";
import { RepoRoot } from "./helpers.js";

// jsdom makes utils.loadData take the browser branch, so back XMLHttpRequest
// with the files the dev server would serve.
class FileBackedXhr {
    open(_method, url) {
        this._url = url;
    }

    overrideMimeType() {}

    send() {
        const served = path.join(RepoRoot, "public", this._url);
        const file = existsSync(served) ? served : path.join(RepoRoot, this._url);
        try {
            this.response = new Uint8Array(readFileSync(file));
            this.status = 200;
        } catch {
            this.status = 404;
        }
        this.onload();
    }
}

describe("the media window against a real machine", () => {
    beforeEach(() => {
        domFromIndexHtml(
            "header-bar",
            "econetfs",
            "paste-text",
            "leds",
            "media-panel",
            "drive-bay-template",
            "save-state",
            "load-state",
        );
        document.querySelector(".media-header").setPointerCapture = () => {};
        vi.stubGlobal("XMLHttpRequest", FileBackedXhr);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        teardownDom();
    });

    const setUp = async ({ search = "", driveTracks = [DriveTracks.auto, DriveTracks.auto] } = {}) => {
        const machine = new TestMachine();
        await machine.initialise();
        const urlState = fakeUrlState(search);
        const drives = new Drives({
            fdc: machine.processor.fdc,
            driveTracks,
            confirm: async () => false,
            urlState,
        });
        const media = new MediaLoader({
            processor: machine.processor,
            model: machine.model,
            drives,
            urlState,
            modals: { hide: vi.fn() },
            isSnapshotFile: () => false,
            loadSnapshot: () => {},
        });
        const window = new MediaWindow({
            media,
            drives,
            processor: machine.processor,
            model: machine.model,
            loop: new EventTarget(),
            visualiser: { openOn: vi.fn() },
            autoboot: vi.fn(),
            driveSource: { connect: vi.fn(), connected: false, createBlank: vi.fn() },
        });
        return { machine, urlState, drives, media, window };
    };
    const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
    const search = async (query) => {
        const box = document.getElementById("media-search");
        box.value = query;
        box.dispatchEvent(new Event("input"));
        await vi.waitFor(() =>
            expect(document.querySelector("#media-list .media-row-main")?.title).toMatch(new RegExp(query, "i")),
        );
        return box;
    };
    const rowDetail = (title) =>
        [...document.querySelectorAll("#media-list .media-row-main")]
            .find((row) => text(row.querySelector(".title")) === title)
            ?.querySelector(".detail");
    const expectRowDetail = (title, matcher) =>
        vi.waitFor(() => expect(text(rowDetail(title) ?? { textContent: "(no row)" })).toMatch(matcher));
    const publicFile = (relative) => readFileSync(path.join(RepoRoot, "public", relative));
    const dropOnPasteBox = (name, bytes) => {
        const event = new Event("drop", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: { files: [new File([bytes], name)] } });
        document.getElementById("paste-text").dispatchEvent(event);
    };

    it("loads the built-in Elite into drive 0 from the list, names it in the URL and catalogues it", async () => {
        const { machine, urlState, media, window } = await setUp();
        const mediaEvents = [];
        media.slots.addEventListener("changed", (e) => {
            if (!e.detail.slot.busy) mediaEvents.push(e.detail.slot.urlParams());
        });

        window.open();
        const search = document.getElementById("media-search");
        search.value = "elite";
        search.dispatchEvent(new Event("input"));
        await vi.waitFor(() =>
            expect(document.querySelector("#media-list .media-row-main .title")?.textContent).toBe("Elite"),
        );
        document.querySelector("#media-list .media-row-main").click();

        await vi.waitFor(() => expect(machine.processor.fdc.drives[0].disc?.name).toBe("elite.ssd"));
        expect(urlState.params.disc1).toBe("elite.ssd");
        expect(mediaEvents).toEqual([{ disc: undefined, disc1: "elite.ssd" }]);
        expect(window.isOpen).toBe(false);
        expect(document.querySelector('.bay[data-drive="0"] .bay-dfs').textContent).toBe("Elite (05)");

        await machine.runUntilInput();
        const seen = [];
        machine.captureText((element) => seen.push(element.text));
        await machine.type("*CAT");
        await machine.runUntilInput();

        const catalogue = seen.join("\n");
        expect(catalogue).toContain("Elite");
        expect(catalogue).toContain("LOAD");
    });

    it("rejects a disc that is not there and leaves the drive empty", async () => {
        const { machine, drives, media } = await setUp();
        expect(machine.processor.fdc.drives[0].disc).toBeUndefined();
        await expect(media.loadDiscImage("nosuch.ssd", drives.layoutForDrive(0))).rejects.toThrow(
            "Unable to load discs/nosuch.ssd, http code 404",
        );
        expect(machine.processor.fdc.drives[0].disc).toBeUndefined();
        await machine.runUntilInput();
    });

    it("keeps the disc dropped in while a slower load was still on its way", async () => {
        const { machine, urlState, media, window } = await setUp();
        let finishSlow;
        media.addSource("sth", () => new Promise((resolve) => (finishSlow = resolve)));
        media.addLister("sth", async () => [
            { ref: "sth:Slow/Slow.zip", kind: "disc", title: "Slow", publisher: "", detail: "", source: "sth" },
        ]);
        window.open();
        await search("slow");
        document.querySelector("#media-list .media-row-main").click();
        await vi.waitFor(() => expect(document.querySelector('.bay[data-drive="0"]').dataset.state).toBe("busy"));

        dropOnPasteBox("Welcome.ssd", publicFile("discs/Welcome.ssd"));
        await vi.waitFor(() => expect(machine.processor.fdc.drives[0].disc?.name).toBe("Welcome.ssd"));
        finishSlow({ name: "Slow.ssd", data: publicFile("discs/elite.ssd"), ignored: [] });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(machine.processor.fdc.drives[0].disc.name).toBe("Welcome.ssd");
        expect(urlState.params.disc1).toBeUndefined();
        expect(text(document.querySelector('.bay[data-drive="0"] .bay-title'))).toBe("Welcome.ssd");
        expect(text(document.querySelector('#leds .slot-readout[data-slot="0"] .name'))).toBe("Welcome");
        await search("");
        await expectRowDetail("Welcome.ssd", /in drive 0/);
        expect(text(rowDetail("Slow"))).not.toContain("in drive");
    });

    it("restores a saved state's disc, URL and pitch, and leaves everything alone when it cannot", async () => {
        const { machine, urlState, drives, media, window } = await setUp();
        const modals = { showError: vi.fn() };
        const ui = new SnapshotUI({
            processor: machine.processor,
            model: machine.model,
            video: { paint: vi.fn() },
            media,
            urlState,
            modals,
            loop: { pause: () => () => {} },
        });
        window.open();
        await search("elite");
        document.querySelector("#media-list .media-row-main").click();
        await vi.waitFor(() => expect(machine.processor.fdc.drives[0].disc?.name).toBe("elite.ssd"));
        await machine.runUntilInput();
        const snapshot = createSnapshot(machine.processor, machine.model, snapshotMedia(media.slots));

        media.slots.eject(media.slots.drive(0));
        window.open();
        await search("welcome");
        document.querySelector("#media-list .media-row-main").click();
        await vi.waitFor(() => expect(machine.processor.fdc.drives[0].disc?.name).toBe("Welcome.ssd"));
        drives.setTracksPerStep(0, 2);
        expect(urlState.params.drive0Tracks).toBe("40");

        await ui.restore(snapshot);
        expect(machine.processor.fdc.drives[0].disc.name).toBe("elite.ssd");
        expect(urlState.params.disc1).toBe("elite.ssd");
        const bay = document.querySelector('.bay[data-drive="0"]');
        expect(text(bay.querySelector(".bay-title"))).toBe("Elite");
        const shownPitch = bay.querySelector('input[value="40"]').checked ? 2 : 1;
        expect(shownPitch).toBe(machine.processor.fdc.drives[0].tracksPerStep);

        const broken = JSON.parse(snapshotToJSON(snapshot));
        broken.media.disc1 = "nosuch.ssd";
        const restored = await ui.loadStateFromFile(null, new TextEncoder().encode(JSON.stringify(broken)).buffer);
        expect(restored).toBe(false);
        expect(modals.showError).toHaveBeenCalled();
        expect(machine.processor.fdc.drives[0].disc.name).toBe("elite.ssd");
        expect(urlState.params.disc1).toBe("elite.ssd");
    });

    it("keeps the URL and the machine agreeing through a startup load, the switch, an eject and a boot", async () => {
        const { machine, urlState, drives, media, window } = await setUp({
            search: "?disc=elite.ssd&drive0Tracks=40",
            driveTracks: [DriveTracks.forty, DriveTracks.auto],
        });
        await media.slots.load(media.slots.drive(0), describeRef("elite.ssd", "disc"));
        window.open();
        const bay = (driveIndex) => document.querySelector(`.bay[data-drive="${driveIndex}"]`);
        expect(text(bay(0).querySelector(".bay-sub"))).toBe("40 track · 1 side · built in");
        expect(bay(0).querySelector('input[value="40"]').checked).toBe(true);

        drives.setTracksPerStep(0, 1);
        expect(urlState.params.drive0Tracks).toBe("80");
        expect(machine.processor.fdc.drives[0].tracksPerStep).toBe(1);

        media.slots.eject(media.slots.drive(0));
        expect(urlState.params.disc).toBeUndefined();
        expect(urlState.params.disc1).toBeUndefined();
        expect(text(bay(0).querySelector(".bay-title"))).toBe("");

        await search("welcome");
        document.querySelector("#media-list .media-row .media-target").click();
        await vi.waitFor(() => expect(machine.processor.fdc.drives[1].disc?.name).toBe("Welcome.ssd"));
        expect(urlState.params.disc2).toBe("Welcome.ssd");

        const reset = vi.spyOn(machine.processor, "reset");
        window.open();
        const box = await search("elite");
        box.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
        );
        await vi.waitFor(() => expect(machine.processor.fdc.drives[0].disc?.name).toBe("elite.ssd"));
        expect(urlState.params.autoboot).toBe(true);
        expect(urlState.params.disc1).toBe("elite.ssd");
        expect(reset).toHaveBeenCalledWith(true);

        window.open();
        await search("");
        await expectRowDetail("Elite", /in drive 0/);
        await expectRowDetail("Welcome", /in drive 1/);
    });
});

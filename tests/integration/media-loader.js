// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaLoader } from "../../src/web/media-loader.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { TestMachine } from "../test-machine.js";
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

describe("the built-in disc list", () => {
    beforeEach(() => {
        domFromIndexHtml("header-bar", "discs", "econetfs", "tapes", "paste-text");
        vi.stubGlobal("XMLHttpRequest", FileBackedXhr);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        teardownDom();
    });

    it("clicks Elite into drive 0, names it in the URL and catalogues it", async () => {
        const machine = new TestMachine();
        await machine.initialise();
        const urlState = fakeUrlState();
        const modals = { hide: vi.fn() };
        const drives = new Drives({
            fdc: machine.processor.fdc,
            driveTracks: [DriveTracks.auto, DriveTracks.auto],
            confirm: async () => false,
        });
        const media = new MediaLoader({
            processor: machine.processor,
            model: machine.model,
            drives,
            urlState,
            modals,
            isSnapshotFile: () => false,
            loadSnapshot: () => {},
        });
        const mediaEvents = [];
        media.addEventListener("media-changed", (e) => mediaEvents.push(e.detail));

        const elite = [...document.querySelectorAll("#disc-list li:not(.template)")].find(
            (li) => li.querySelector(".name")?.textContent === "Elite",
        );
        expect(elite).toBeDefined();
        elite.click();

        await vi.waitFor(() => expect(machine.processor.fdc.drives[0].disc?.name).toBe("elite.ssd"));
        expect(urlState.params.disc1).toBe("elite.ssd");
        expect(mediaEvents).toEqual([{ disc1: "elite.ssd" }]);
        expect(modals.hide).toHaveBeenCalledWith("discs");

        await machine.runUntilInput();
        const seen = [];
        machine.captureText((element) => seen.push(element.text));
        await machine.type("*CAT");
        await machine.runUntilInput();

        const catalogue = seen.join("\n");
        expect(catalogue).toContain("Elite");
        expect(catalogue).toContain("LOAD");
    });
});

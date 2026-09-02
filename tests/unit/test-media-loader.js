// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuiltInImages, MediaLoader, splitImage } from "../../src/web/media-loader.js";
import { DiscLayout } from "../../src/disc.js";
import { discFor } from "../../src/fdc.js";
import { toHfe } from "../../src/disc-hfe.js";
import { domFromIndexHtml, fakeUrlState, ssdImage, teardownDom, toasts } from "./helpers.js";

const fileFor = (name, bytes) => new File([bytes], name);

async function pickFile(inputId, file) {
    const input = document.getElementById(inputId);
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    // The handler reads the file asynchronously.
    await vi.waitFor(() => expect(input.value).toBe(""));
}

describe("MediaLoader", () => {
    let deps;
    let sources;

    beforeEach(() => {
        domFromIndexHtml("discs", "econetfs", "tapes", "paste-text");
        deps = {
            processor: {
                fdc: null,
                acia: { setTape: vi.fn() },
                atomppia: { setTape: vi.fn() },
                filestore: {},
                econet: {},
            },
            model: { isAtom: false },
            drives: { layoutForDrive: () => DiscLayout.auto, putDiscIn: vi.fn() },
            urlState: fakeUrlState(),
            modals: { hide: vi.fn() },
            isSnapshotFile: (name) => name.endsWith(".snp"),
            loadSnapshot: vi.fn(),
        };
        vi.spyOn(deps.urlState, "updateUrl");
        sources = { sth: vi.fn(), tapeSth: vi.fn(), hfe: vi.fn(), drive: vi.fn() };
    });

    afterEach(teardownDom);

    const make = () => {
        const media = new MediaLoader(deps);
        for (const [schema, fetcher] of Object.entries(sources)) media.addSource(schema, fetcher);
        return media;
    };

    describe("splitImage", () => {
        it.each([
            ["sth:ELITE.zip", "sth", "ELITE.zip"],
            ["|ELITE.zip", "|", "ELITE.zip"],
            ["hfe:3A1DAB83.hfe", "hfe", "3A1DAB83.hfe"],
            ["gd:abc123/name.ssd", "gd", "abc123/name.ssd"],
            ["local:mydisc", "local", "mydisc"],
            ["!mydisc", "!", "mydisc"],
            ["https://example.com/a.ssd", "https", "example.com/a.ssd"],
            ["elite.ssd", "", "elite.ssd"],
        ])("splits %s into schema %j and image %j", (ref, schema, image) => {
            expect(splitImage(ref)).toEqual({ schema, image });
        });
    });

    describe("loadDiscImage", () => {
        it("returns nothing for no reference", async () => {
            expect(await make().loadDiscImage(undefined)).toBeNull();
        });

        it("fetches an sth: reference and names the disc after what was in the archive", async () => {
            sources.sth.mockResolvedValue({ name: "ELITE.ssd", data: ssdImage(), ignored: [] });
            const loaded = await make().loadDiscImage("sth:ELITE.zip");
            expect(sources.sth).toHaveBeenCalledWith("ELITE.zip");
            expect(loaded.name).toBe("ELITE.ssd");
        });

        it("reports what an archive held besides the file it loaded", async () => {
            sources.sth.mockResolvedValue({ name: "side1.ssd", data: ssdImage(), ignored: ["side2.ssd"] });
            await make().loadDiscImage("sth:Game.zip");
            expect(toasts()).toEqual([expect.stringContaining("side2.ssd")]);
        });

        it("fetches an hfe: reference from the archive", async () => {
            sources.hfe.mockResolvedValue(toHfe(discFor("x.ssd", ssdImage())));
            const loaded = await make().loadDiscImage("hfe:3A1DAB83.hfe");
            expect(sources.hfe).toHaveBeenCalledWith("3A1DAB83.hfe");
            expect(loaded.name).toBe("3A1DAB83.hfe");
        });

        it("splits a gd: reference into the file id and name for the Drive source", async () => {
            const fromDrive = {};
            sources.drive.mockResolvedValue(fromDrive);
            const loaded = await make().loadDiscImage("gd:abc123/mydisc.ssd", DiscLayout.contiguous);
            expect(sources.drive).toHaveBeenCalledWith({ id: "abc123", name: "mydisc.ssd" }, DiscLayout.contiguous);
            expect(loaded).toBe(fromDrive);
        });

        it("decodes a b64data: reference into an anonymous disc", async () => {
            const image = ssdImage();
            const loaded = await make().loadDiscImage(
                "b64data:" + btoa(String.fromCharCode(...image.subarray(0, 0x200))),
            );
            expect(loaded.name).toBe("disk.ssd");
        });
    });

    describe("loadTapeImage", () => {
        it("returns nothing for no reference", async () => {
            expect(await make().loadTapeImage(undefined)).toBeNull();
        });
    });

    describe("the URL and the media-changed events", () => {
        const mediaEvents = [];
        beforeEach(() => {
            mediaEvents.length = 0;
        });
        const makeWatched = () => {
            const media = make();
            media.addEventListener("media-changed", (e) => mediaEvents.push(e.detail));
            return media;
        };

        it("names drive 0's disc, displacing any bare disc parameter", () => {
            deps.urlState.params.disc = "old.ssd";
            makeWatched().setDisc1Image("sth:ELITE.zip");
            expect(deps.urlState.params).toEqual({ disc1: "sth:ELITE.zip" });
            expect(deps.urlState.updateUrl).toHaveBeenCalledTimes(1);
            expect(mediaEvents).toEqual([{ disc1: "sth:ELITE.zip" }]);
        });

        it("names drive 1's disc and the tape", () => {
            const media = makeWatched();
            media.setDisc2Image("b.ssd");
            media.setTapeImage("sth:Chuckie.zip");
            expect(deps.urlState.params).toEqual({ disc2: "b.ssd", tape: "sth:Chuckie.zip" });
            expect(mediaEvents).toEqual([{ disc2: "b.ssd" }, { tape: "sth:Chuckie.zip" }]);
        });
    });

    describe("the built-in list", () => {
        it("offers every built-in image by name", () => {
            make();
            const names = [...document.querySelectorAll("#disc-list li:not(.template) .name")].map(
                (el) => el.textContent,
            );
            expect(names).toEqual(BuiltInImages.map((image) => image.name));
        });
    });

    describe("the local disc input", () => {
        it("puts the file in drive 0 and takes the disc out of the URL", async () => {
            deps.urlState.params.disc1 = "elite.ssd";
            make();
            await pickFile("disc_load", fileFor("mine.ssd", ssdImage()));
            await vi.waitFor(() => expect(deps.drives.putDiscIn).toHaveBeenCalled());
            const [driveIndex, loaded] = deps.drives.putDiscIn.mock.calls[0];
            expect(driveIndex).toBe(0);
            expect(loaded.name).toBe("mine.ssd");
            expect(loaded.originalImageData).toBeTruthy();
            expect(deps.urlState.params.disc1).toBeUndefined();
            expect(deps.modals.hide).toHaveBeenCalledWith("discs");
        });

        it("reports a file the disc code cannot take", async () => {
            make();
            await pickFile("disc_load", fileFor("broken.hfe", new Uint8Array(3)));
            await vi.waitFor(() => expect(toasts()).toEqual([expect.stringContaining("Could not load broken.hfe")]));
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        });
    });

    describe("the filestore input", () => {
        it("loads the SCSI image and restarts the filestore", async () => {
            make();
            await pickFile("fs_load", fileFor("scsi.dat", new Uint8Array([1, 2, 3])));
            await vi.waitFor(() => expect(deps.modals.hide).toHaveBeenCalledWith("econetfs"));
            expect([...deps.processor.filestore.scsi]).toEqual([1, 2, 3]);
            expect(deps.processor.filestore.PC).toBe(0x400);
            expect(deps.processor.econet.receiveBlocks).toEqual([]);
        });

        it("quietly ignores a SCSI image when no filestore is fitted", async () => {
            deps.processor.filestore = undefined;
            await make().loadSCSIFile(fileFor("scsi.dat", new Uint8Array([1, 2, 3])));
            expect(deps.modals.hide).not.toHaveBeenCalled();
        });
    });

    describe("the local tape input", () => {
        // "UEF File!" header, then one data chunk, the least loadTapeFromData accepts.
        const uefImage = () =>
            new Uint8Array([
                0x55, 0x45, 0x46, 0x20, 0x46, 0x69, 0x6c, 0x65, 0x21, 0x00, 0x06, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00,
                0x00, 0x41,
            ]);

        it("routes the file to the cassette interface and takes the tape out of the URL", async () => {
            deps.urlState.params.tape = "old.uef";
            make();
            await pickFile("tape_load", fileFor("mine.uef", uefImage()));
            await vi.waitFor(() => expect(deps.processor.acia.setTape).toHaveBeenCalled());
            expect(deps.processor.acia.setTape.mock.calls[0][0]).toBeTruthy();
            expect(deps.urlState.params.tape).toBeUndefined();
            expect(deps.modals.hide).toHaveBeenCalledWith("tapes");
        });

        it("reports a file the tape code cannot take", async () => {
            make();
            await pickFile("tape_load", fileFor("noise.uef", new Uint8Array(12)));
            await vi.waitFor(() => expect(toasts()).toEqual([expect.stringContaining("Could not load noise.uef")]));
            expect(deps.processor.acia.setTape).not.toHaveBeenCalled();
        });
    });

    describe("the drop zone", () => {
        const drop = (file) => {
            const event = new Event("drop", { bubbles: true, cancelable: true });
            Object.defineProperty(event, "dataTransfer", { value: { files: file ? [file] : [] } });
            document.getElementById("paste-text").dispatchEvent(event);
        };

        it("hands a save state to the snapshot loader", async () => {
            make();
            drop(fileFor("state.snp", new Uint8Array([1])));
            await vi.waitFor(() => expect(deps.loadSnapshot).toHaveBeenCalled());
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        });

        it("puts a dropped disc in drive 0 and says so", async () => {
            make();
            drop(fileFor("dropped.ssd", ssdImage()));
            await vi.waitFor(() => expect(deps.drives.putDiscIn).toHaveBeenCalled());
            expect(toasts()).toEqual([expect.stringContaining("Loaded dropped.ssd into drive 0.")]);
        });

        it("does nothing when nothing was dropped", async () => {
            make();
            drop(null);
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
            expect(deps.loadSnapshot).not.toHaveBeenCalled();
        });
    });

    describe("setProcessorTape", () => {
        it("routes the tape to the ACIA on a BBC and the PPIA on an Atom", () => {
            const tape = {};
            make().setProcessorTape(tape);
            expect(deps.processor.acia.setTape).toHaveBeenCalledWith(tape);
            deps.model.isAtom = true;
            make().setProcessorTape(tape);
            expect(deps.processor.atomppia.setTape).toHaveBeenCalledWith(tape);
        });
    });
});

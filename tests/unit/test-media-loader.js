// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuiltInImages, MediaLoader } from "../../src/web/media-loader.js";
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
                tapeInterface: { setTape: vi.fn() },
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
            makeWatched().setDiscImage(0, "sth:ELITE.zip");
            expect(deps.urlState.params).toEqual({ disc1: "sth:ELITE.zip" });
            expect(deps.urlState.updateUrl).toHaveBeenCalledTimes(1);
            expect(mediaEvents).toEqual([{ disc1: "sth:ELITE.zip" }]);
        });

        it("names drive 1's disc and the tape", () => {
            const media = makeWatched();
            media.setDiscImage(1, "b.ssd");
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

        it("puts the clicked image in drive 0, then names it in the URL", async () => {
            const media = make();
            const loaded = {};
            vi.spyOn(media, "loadDiscImage").mockResolvedValue(loaded);
            document.querySelector("#disc-list li:not(.template)").click();
            await vi.waitFor(() => expect(deps.drives.putDiscIn).toHaveBeenCalledWith(0, loaded));
            expect(media.loadDiscImage).toHaveBeenCalledWith("elite.ssd", DiscLayout.auto);
            expect(deps.urlState.params).toEqual({ disc1: "elite.ssd" });
            expect(deps.modals.hide).toHaveBeenCalledWith("discs");
        });

        it("leaves the URL alone when the image will not load", async () => {
            const media = make();
            vi.spyOn(console, "error").mockImplementation(() => {});
            vi.spyOn(media, "loadDiscImage").mockRejectedValue(new Error("offline"));
            document.querySelector("#disc-list li:not(.template)").click();
            await vi.waitFor(() => expect(toasts()).toEqual([expect.stringContaining("Could not load Elite")]));
            expect(deps.urlState.params).toEqual({});
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
            await vi.waitFor(() => expect(deps.processor.tapeInterface.setTape).toHaveBeenCalled());
            expect(deps.processor.tapeInterface.setTape.mock.calls[0][0]).toBeTruthy();
            expect(deps.urlState.params.tape).toBeUndefined();
            expect(deps.modals.hide).toHaveBeenCalledWith("tapes");
        });

        it("reports a file the tape code cannot take", async () => {
            make();
            await pickFile("tape_load", fileFor("noise.uef", new Uint8Array(12)));
            await vi.waitFor(() => expect(toasts()).toEqual([expect.stringContaining("Could not load noise.uef")]));
            expect(deps.processor.tapeInterface.setTape).not.toHaveBeenCalled();
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

    describe("files opened this session", () => {
        it("remembers a disc file, lists it, and can put it in either drive again by reference", async () => {
            const media = make();
            expect(await media.openFile(fileFor("mine.ssd", ssdImage()), 1)).toBe("Loaded mine.ssd into drive 1.");
            expect(deps.drives.putDiscIn).toHaveBeenCalledWith(1, expect.objectContaining({ name: "mine.ssd" }));
            expect(deps.urlState.params.disc2).toBeUndefined();
            const { descriptors } = await media.listAll();
            expect(descriptors).toContainEqual(expect.objectContaining({ ref: "session:mine.ssd", kind: "disc" }));
            const again = await media.loadDiscImage("session:mine.ssd");
            expect(again.name).toBe("mine.ssd");
            expect(again.originalImageData).toBeTruthy();
        });

        it("says when a reference names a file that was never opened", async () => {
            await expect(make().loadDiscImage("session:ghost.ssd")).rejects.toThrow("ghost.ssd was not opened");
        });

        it("lists the built-in discs and the browser's discs alongside", async () => {
            window.localStorage.setItem("disc_saves.ssd", "");
            const { descriptors, failures } = await make().listAll();
            expect(failures).toEqual([]);
            expect(descriptors.map((d) => d.ref)).toEqual([
                ...BuiltInImages.map((image) => image.file),
                "local:saves.ssd",
            ]);
        });

        it("keeps listing when one source fails, and says which", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const media = make();
            media.addLister("sth", async () => {
                throw new Error("offline");
            });
            const { descriptors, failures } = await media.listAll();
            expect(descriptors.length).toBe(BuiltInImages.length);
            expect(failures).toEqual(["sth: offline"]);
        });
    });

    describe("setProcessorTape", () => {
        it("hands the tape to the machine's tape interface and says the deck changed", () => {
            const tape = {};
            const media = make();
            const seen = [];
            media.addEventListener("tape-changed", (e) => seen.push(e.detail));
            media.setProcessorTape(tape);
            expect(deps.processor.tapeInterface.setTape).toHaveBeenCalledWith(tape);
            expect(seen).toEqual([{ tape }]);
        });
    });

    describe("ejecting", () => {
        it("empties a drive and takes its disc out of the URL", () => {
            deps.drives.eject = vi.fn();
            deps.urlState.params.disc1 = "sth:ELITE.zip";
            deps.urlState.params.disc2 = "b.ssd";
            const media = make();
            media.ejectDisc(0);
            expect(deps.drives.eject).toHaveBeenCalledWith(0);
            expect(deps.urlState.params).toEqual({ disc2: "b.ssd" });
            media.ejectDisc(1);
            expect(deps.drives.eject).toHaveBeenLastCalledWith(1);
            expect(deps.urlState.params).toEqual({});
        });

        it("empties the deck and takes the tape out of the URL", () => {
            deps.urlState.params.tape = "sth:Chuckie.zip";
            make().ejectTape();
            expect(deps.processor.tapeInterface.setTape).toHaveBeenCalledWith(undefined);
            expect(deps.urlState.params).toEqual({});
        });
    });
});

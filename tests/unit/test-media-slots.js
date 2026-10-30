// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaSlots } from "../../src/web/media-slots.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
import { fakeFdc, fakeUrlState, sentEvents, ssdImage, teardownDom, toasts } from "./helpers.js";
import { failedFor, LoadFailures } from "../../src/loader.js";

const elite = { ref: "sth:Games/Elite.zip", kind: "disc", title: "Elite", publisher: "", detail: "", source: "sth" };
const chuckie = {
    ref: "sth:AnF/Chuckie.zip",
    kind: "tape",
    title: "Chuckie",
    publisher: "",
    detail: "",
    source: "sth",
};
const opened = {
    ref: "session:mine.ssd",
    kind: "disc",
    title: "mine.ssd",
    publisher: "",
    detail: "",
    source: "session",
};

describe("MediaSlots", () => {
    let fdc;
    let tapeInterface;
    let loader;
    let urlState;
    let slots;
    let changes;

    beforeEach(() => {
        fdc = fakeFdc();
        tapeInterface = { tape: undefined, setTape: vi.fn((tape) => (tapeInterface.tape = tape)) };
        loader = { loadDiscImage: vi.fn(), loadTapeImage: vi.fn() };
        urlState = fakeUrlState();
        const drives = new Drives({
            fdc,
            hasDiscDrives: true,
            driveTracks: [DriveTracks.auto, DriveTracks.auto],
            confirm: vi.fn(),
            urlState,
        });
        slots = new MediaSlots({ loader, drives, processor: { fdc, tapeInterface }, urlState });
        changes = [];
        slots.addEventListener("changed", (e) => changes.push(e.detail.slot.name));
    });

    afterEach(teardownDom);

    const ssd = (name) => discFor(name, ssdImage());
    const deferred = () => {
        let resolve;
        let reject;
        const promise = new Promise((yes, no) => {
            resolve = yes;
            reject = no;
        });
        return { promise, resolve, reject };
    };

    describe("loading", () => {
        it("puts a disc in the drive it was asked for and names it in the URL, saying so twice over", async () => {
            const disc = ssd("elite.ssd");
            loader.loadDiscImage.mockResolvedValue(disc);
            expect(await slots.load(slots.drive(1), elite)).toBe("loaded");
            expect(loader.loadDiscImage).toHaveBeenCalledWith("sth:Games/Elite.zip", "auto");
            expect(fdc.drives[1].disc).toBe(disc);
            expect(slots.drive(1).ref).toBe("sth:Games/Elite.zip");
            expect(urlState.params).toEqual({ disc2: "sth:Games/Elite.zip" });
            expect(changes).toEqual(["drive 1", "drive 1"]);
        });

        it("puts a tape in the deck", async () => {
            const tape = { name: "chuckie.uef" };
            loader.loadTapeImage.mockResolvedValue(tape);
            expect(await slots.load(slots.deck, chuckie)).toBe("loaded");
            expect(tapeInterface.setTape).toHaveBeenCalledWith(tape);
            expect(urlState.params).toEqual({ tape: "sth:AnF/Chuckie.zip" });
        });

        it("names drive 0 as disc1, displacing any bare disc parameter", async () => {
            urlState.params.disc = "old.ssd";
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            await slots.load(slots.drive(0), elite);
            expect(urlState.params).toEqual({ disc1: "sth:Games/Elite.zip" });
        });

        it("keeps a file opened this session out of the URL, but knows the slot by it", async () => {
            loader.loadDiscImage.mockResolvedValue(ssd("mine.ssd"));
            await slots.load(slots.drive(0), opened);
            expect(urlState.params).toEqual({});
            expect(slots.drive(0).ref).toBe("session:mine.ssd");
            expect(slots.holding("session:mine.ssd")).toBe(slots.drive(0));
        });

        it("leaves a URL alone that already names the disc, however it spells the drive", async () => {
            urlState.params.disc = "elite.ssd";
            vi.spyOn(urlState, "set");
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            await slots.load(slots.drive(0), { ...elite, ref: "elite.ssd" });
            expect(urlState.set).not.toHaveBeenCalled();
            expect(urlState.params).toEqual({ disc: "elite.ssd" });
            await slots.load(slots.drive(1), { ...elite, ref: "elite.ssd" }, { inUrl: false });
            expect(urlState.set).not.toHaveBeenCalled();
        });

        it("is told when the URL is not to name what it loaded", async () => {
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            await slots.load(slots.drive(0), { ...elite, ref: "elite.ssd" }, { inUrl: false });
            expect(urlState.params).toEqual({});
            expect(slots.drive(0).ref).toBe("elite.ssd");
        });

        it("shows the load in flight, and a failure with what failed", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const pending = deferred();
            loader.loadDiscImage.mockReturnValue(pending.promise);
            const loading = slots.load(slots.drive(0), elite);
            expect(slots.drive(0).busy).toBe(elite);
            pending.reject(new Error("HTTP 404"));
            expect(await loading).toBe("failed");
            expect(slots.drive(0).busy).toBeNull();
            expect(slots.drive(0).failed).toEqual({ descriptor: elite, error: new Error("HTTP 404") });
            expect(toasts()).toEqual([expect.stringContaining("Could not load Elite from STH archive: HTTP 404")]);
            expect(urlState.params).toEqual({});
        });

        it("ends up with the last load asked for, whichever finishes first", async () => {
            const first = deferred();
            const second = ssd("b.ssd");
            loader.loadDiscImage.mockReturnValueOnce(first.promise).mockResolvedValueOnce(second);
            const firstLoad = slots.load(slots.drive(0), elite);
            const secondLoad = slots.load(slots.drive(0), { ...elite, ref: "sth:B.zip", title: "B" });
            expect(await secondLoad).toBe("loaded");
            first.resolve(ssd("a.ssd"));
            expect(await firstLoad).toBe("overtaken");
            expect(fdc.drives[0].disc).toBe(second);
            expect(urlState.params.disc1).toBe("sth:B.zip");
        });

        it("keeps a failure from an overtaken load to itself", async () => {
            const first = deferred();
            loader.loadDiscImage.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ssd("b.ssd"));
            const firstLoad = slots.load(slots.drive(0), elite);
            await slots.load(slots.drive(0), { ...elite, ref: "sth:B.zip" });
            first.reject(new Error("late"));
            expect(await firstLoad).toBe("overtaken");
            expect(slots.drive(0).failed).toBeNull();
            expect(toasts()).toEqual([]);
        });

        it("settles a slot whose load resolved to nothing, without a failure", async () => {
            loader.loadDiscImage.mockResolvedValue(null);
            expect(await slots.load(slots.drive(0), elite)).toBe("nothing");
            expect(slots.drive(0).busy).toBeNull();
            expect(slots.drive(0).failed).toBeNull();
            expect(toasts()).toEqual([]);
        });

        it("takes the media a fetch of its own makes, and the reference it says it has", async () => {
            const made = ssd("fresh.ssd");
            const outcome = await slots.load(
                slots.drive(0),
                { ...elite, title: "fresh.ssd", source: "gdrive" },
                {
                    fetch: async () => ({ media: made, ref: "gd:xyz/fresh.ssd" }),
                },
            );
            expect(outcome).toBe("loaded");
            expect(fdc.drives[0].disc).toBe(made);
            expect(urlState.params.disc1).toBe("gd:xyz/fresh.ssd");
        });

        it("notes what went in each slot as loaded recently, but not a load that failed", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            loader.loadTapeImage.mockResolvedValue({ name: "chuckie.uef" });
            await slots.load(slots.deck, chuckie);
            slots.put(slots.drive(1), ssd("mine.ssd"), opened.ref, { inUrl: false });
            loader.loadDiscImage.mockRejectedValue(new Error("Not found"));
            await slots.load(slots.drive(0), elite);
            expect(slots.recent.rank(opened)).toBe(0);
            expect(slots.recent.rank(chuckie)).toBe(1);
            expect(slots.recent.rank(elite)).toBe(-1);
        });

        it("fails a disc load, in words, on a machine without disc drives", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const drives = new Drives({
                fdc,
                hasDiscDrives: false,
                driveTracks: [DriveTracks.auto, DriveTracks.auto],
                urlState,
            });
            const none = new MediaSlots({ loader, drives, processor: { fdc, tapeInterface }, urlState });
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            expect(await none.load(none.drive(0), elite)).toBe("failed");
            expect(none.drive(0).failed.error.message).toBe("This machine has no disc drives");
            expect(fdc.loadDisc).not.toHaveBeenCalled();
            expect(urlState.params).toEqual({});
        });
    });

    describe("putting in and taking out", () => {
        it.each([
            ["a load", () => slots.load(slots.drive(0), elite, { recent: false })],
            ["media put in", () => slots.put(slots.drive(0), ssd("elite.ssd"), elite.ref, { recent: false })],
        ])("leaves what was loaded recently alone when told %s is not a new one", async (_, putIn) => {
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            await putIn();
            expect(fdc.drives[0].disc).toBeTruthy();
            expect(slots.recent.rank(elite)).toBe(-1);
        });

        it("puts media that is to hand straight in, overtaking any load in flight", async () => {
            const pending = deferred();
            loader.loadDiscImage.mockReturnValue(pending.promise);
            const loading = slots.load(slots.drive(0), elite);
            const dropped = ssd("dropped.ssd");
            slots.put(slots.drive(0), dropped, "session:dropped.ssd", { inUrl: false });
            expect(slots.drive(0).busy).toBeNull();
            pending.resolve(ssd("elite.ssd"));
            expect(await loading).toBe("overtaken");
            expect(fdc.drives[0].disc).toBe(dropped);
        });

        it("ejects, clearing the drive, the reference and the URL", async () => {
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            await slots.load(slots.drive(0), elite);
            slots.eject(slots.drive(0));
            expect(fdc.drives[0].disc).toBeUndefined();
            expect(slots.drive(0).ref).toBeUndefined();
            expect(urlState.params).toEqual({});
            expect(slots.holding("sth:Games/Elite.zip")).toBeNull();
        });

        it("leaves what was loaded recently alone on an eject", async () => {
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            await slots.load(slots.drive(0), elite);
            slots.eject(slots.drive(0));
            expect(slots.recent.entries).toEqual([{ ref: elite.ref, kind: "disc" }]);
        });

        it("ejects the tape likewise", async () => {
            loader.loadTapeImage.mockResolvedValue({ name: "t.uef" });
            await slots.load(slots.deck, chuckie);
            slots.eject(slots.deck);
            expect(tapeInterface.setTape).toHaveBeenLastCalledWith(undefined);
            expect(urlState.params).toEqual({});
        });

        it("says every slot changed once a state has been restored, the switches first", () => {
            const followed = vi.spyOn(slots.drives, "followRestoredPitch");
            slots.restored();
            expect(followed.mock.calls).toEqual([[0], [1]]);
            expect(changes).toEqual(["drive 0", "drive 1", "the deck"]);
        });
    });

    describe("analytics", () => {
        let sent;

        beforeEach(() => {
            sent = sentEvents();
            vi.spyOn(console, "error").mockImplementation(() => {});
        });

        it("notes a load with where it came from, how it was asked for and how it ended", async () => {
            loader.loadDiscImage.mockResolvedValue(ssd("elite.ssd"));
            await slots.load(slots.drive(1), elite, { entry: "list" });
            loader.loadTapeImage.mockResolvedValue(null);
            await slots.load(slots.deck, chuckie, { entry: "url" });
            expect(sent("media_load")).toEqual([
                { source: "sth", kind: "disc", slot: "drive1", entry: "list", ref: elite.ref, result: "loaded" },
                { source: "sth", kind: "tape", slot: "deck", entry: "url", ref: chuckie.ref, result: "nothing" },
            ]);
            expect(sent("load_failed")).toEqual([]);
        });

        it("names the user's own media only by its source, and takes the reference a fetch ends up with", async () => {
            const making = { ...elite, ref: undefined, title: "fresh.ssd", source: "gdrive" };
            await slots.load(slots.drive(0), making, {
                entry: "create",
                fetch: async () => ({ media: ssd("fresh.ssd"), ref: "gd:xyz/fresh.ssd" }),
            });
            await slots.load(slots.drive(0), making, {
                entry: "create",
                fetch: async () => {
                    throw new Error("Drive is full");
                },
            });
            expect(sent("media_load")).toEqual([
                { source: "gdrive", kind: "disc", slot: "drive0", entry: "create", ref: "gdrive", result: "loaded" },
                { source: "gdrive", kind: "disc", slot: "drive0", entry: "create", result: "failed" },
            ]);
        });

        it("notes why a load failed, as the error says, or as other", async () => {
            loader.loadDiscImage.mockRejectedValueOnce(failedFor(new Error("gone"), LoadFailures.notFound));
            await slots.load(slots.drive(0), elite, { entry: "retry" });
            loader.loadTapeImage.mockRejectedValueOnce(new Error("odd"));
            await slots.load(slots.deck, chuckie, { entry: "list" });
            expect(sent("media_load").map(({ result }) => result)).toEqual(["failed", "failed"]);
            expect(sent("load_failed")).toEqual([
                { source: "sth", kind: "disc", reason: "not_found" },
                { source: "sth", kind: "tape", reason: "other" },
            ]);
        });

        it("notes an overtaken load as overtaken, and not as a failure", async () => {
            const first = deferred();
            loader.loadDiscImage.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ssd("b.ssd"));
            const firstLoad = slots.load(slots.drive(0), elite, { entry: "list" });
            await slots.load(slots.drive(0), { ...elite, ref: "sth:B.zip" }, { entry: "list" });
            first.reject(new Error("late"));
            await firstLoad;
            expect(sent("media_load").map(({ result }) => result)).toEqual(["loaded", "overtaken"]);
            expect(sent("load_failed")).toEqual([]);
        });

        it("notes media put straight in as loaded", () => {
            slots.put(slots.drive(1), ssd("mine.ssd"), "session:1/mine.ssd", { entry: "drop" });
            slots.put(slots.drive(0), ssd("saved.ssd"), undefined, { entry: "restore" });
            expect(sent("media_load")).toEqual([
                { source: "session", kind: "disc", slot: "drive1", entry: "drop", ref: "session", result: "loaded" },
                { kind: "disc", slot: "drive0", entry: "restore", result: "loaded" },
            ]);
        });
    });
});

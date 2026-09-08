// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaSlots } from "../../src/web/media-slots.js";
import { Drives } from "../../src/web/drives.js";
import { DriveTracks } from "../../src/url-params.js";
import { discFor } from "../../src/fdc.js";
import { fakeFdc, fakeUrlState, ssdImage, teardownDom, toasts } from "./helpers.js";

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
            driveTracks: [DriveTracks.auto, DriveTracks.auto],
            confirm: vi.fn(),
            urlState,
        });
        slots = new MediaSlots({ loader, drives, processor: { fdc, tapeInterface }, urlState });
        changes = [];
        slots.addEventListener("changed", (e) => changes.push(e.detail.slot.name));
    });

    afterEach(teardownDom);

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
            const disc = discFor("elite.ssd", ssdImage());
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
            loader.loadDiscImage.mockResolvedValue(discFor("elite.ssd", ssdImage()));
            await slots.load(slots.drive(0), elite);
            expect(urlState.params).toEqual({ disc1: "sth:Games/Elite.zip" });
        });

        it("keeps a file opened this session out of the URL, but knows the slot by it", async () => {
            loader.loadDiscImage.mockResolvedValue(discFor("mine.ssd", ssdImage()));
            await slots.load(slots.drive(0), opened);
            expect(urlState.params).toEqual({});
            expect(slots.drive(0).ref).toBe("session:mine.ssd");
            expect(slots.holding("session:mine.ssd")).toBe(slots.drive(0));
        });

        it("is told when the URL is not to name what it loaded", async () => {
            loader.loadDiscImage.mockResolvedValue(discFor("elite.ssd", ssdImage()));
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
            const second = discFor("b.ssd", ssdImage());
            loader.loadDiscImage.mockReturnValueOnce(first.promise).mockResolvedValueOnce(second);
            const firstLoad = slots.load(slots.drive(0), elite);
            const secondLoad = slots.load(slots.drive(0), { ...elite, ref: "sth:B.zip", title: "B" });
            expect(await secondLoad).toBe("loaded");
            first.resolve(discFor("a.ssd", ssdImage()));
            expect(await firstLoad).toBe("overtaken");
            expect(fdc.drives[0].disc).toBe(second);
            expect(urlState.params.disc1).toBe("sth:B.zip");
        });

        it("keeps a failure from an overtaken load to itself", async () => {
            const first = deferred();
            loader.loadDiscImage.mockReturnValueOnce(first.promise).mockResolvedValueOnce(discFor("b.ssd", ssdImage()));
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
            const made = discFor("fresh.ssd", ssdImage());
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

        it("fails a disc load, in words, on a machine with no drives", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            const drives = new Drives({ fdc: undefined, driveTracks: [DriveTracks.auto, DriveTracks.auto], urlState });
            const none = new MediaSlots({ loader, drives, processor: { fdc: undefined, tapeInterface }, urlState });
            loader.loadDiscImage.mockResolvedValue(discFor("elite.ssd", ssdImage()));
            expect(await none.load(none.drive(0), elite)).toBe("failed");
            expect(none.drive(0).failed.error.message).toContain("no disc drives");
        });
    });

    describe("putting in and taking out", () => {
        it("puts media that is to hand straight in, overtaking any load in flight", async () => {
            const pending = deferred();
            loader.loadDiscImage.mockReturnValue(pending.promise);
            const loading = slots.load(slots.drive(0), elite);
            const dropped = discFor("dropped.ssd", ssdImage());
            slots.put(slots.drive(0), dropped, "session:dropped.ssd", { inUrl: false });
            expect(slots.drive(0).busy).toBeNull();
            pending.resolve(discFor("elite.ssd", ssdImage()));
            expect(await loading).toBe("overtaken");
            expect(fdc.drives[0].disc).toBe(dropped);
        });

        it("ejects, clearing the drive, the reference and the URL", async () => {
            loader.loadDiscImage.mockResolvedValue(discFor("elite.ssd", ssdImage()));
            await slots.load(slots.drive(0), elite);
            slots.eject(slots.drive(0));
            expect(fdc.drives[0].disc).toBeUndefined();
            expect(slots.drive(0).ref).toBeUndefined();
            expect(urlState.params).toEqual({});
            expect(slots.holding("sth:Games/Elite.zip")).toBeNull();
        });

        it("ejects the tape likewise", async () => {
            loader.loadTapeImage.mockResolvedValue({ name: "t.uef" });
            await slots.load(slots.deck, chuckie);
            slots.eject(slots.deck);
            expect(tapeInterface.setTape).toHaveBeenLastCalledWith(undefined);
            expect(urlState.params).toEqual({});
        });

        it("says every slot changed once a state has been restored", () => {
            slots.restored();
            expect(changes).toEqual(["drive 0", "drive 1", "the deck"]);
        });

        it("finds slots by the window's targets", () => {
            expect(slots.slotFor(1)).toBe(slots.drive(1));
            expect(slots.slotFor("tape")).toBe(slots.deck);
            expect(slots.deck.urlParams()).toEqual({ tape: undefined });
        });
    });
});

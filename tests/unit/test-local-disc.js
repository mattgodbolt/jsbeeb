import { localDisc } from "../../src/web/local-disc.js";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { DiscLayout } from "../../src/disc.js";

describe("a disc held in browser local storage", () => {
    const stubStorage = (localStorage) => vi.stubGlobal("window", { localStorage });

    const writeTrack = (created, trackNum) => {
        created.writePulses(false, trackNum, 0, 0);
        created.flushWrites();
    };

    beforeEach(() => vi.spyOn(globalThis.console, "log").mockImplementation(() => {}));
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it("keeps its changes", () => {
        const stored = {};
        stubStorage({ setItem: (key, value) => (stored[key] = value) });

        const created = localDisc("kept.ssd", DiscLayout.contiguous);
        writeTrack(created, 0);

        expect(created.savesChanges).toBe(true);
        expect(stored["disc_kept.ssd"]).toBeTypeOf("string");
    });

    it("reports a refused write once however many tracks are written", () => {
        const refusal = new Error("QuotaExceededError");
        stubStorage({
            setItem: () => {
                throw refusal;
            },
        });
        const refused = [];

        const created = localDisc("full.ssd", DiscLayout.contiguous, (error) => refused.push(error));
        for (const trackNum of [0, 1, 2]) writeTrack(created, trackNum);

        expect(refused).toEqual([refusal]);
    });

    it("says nothing while the writes are being stored", () => {
        stubStorage({ setItem: () => {} });
        let refusals = 0;

        writeTrack(
            localDisc("fine.ssd", DiscLayout.contiguous, () => refusals++),
            0,
        );

        expect(refusals).toBe(0);
    });
});

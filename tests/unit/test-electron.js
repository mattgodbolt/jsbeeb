// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialise } from "../../src/app/electron.js";
import { teardownDom, toasts } from "./helpers.js";

describe("the Electron hooks", () => {
    let api;
    let deps;

    beforeEach(() => {
        api = {
            onLoadDisc: vi.fn(),
            onLoadTape: vi.fn(),
            onShowModal: vi.fn(),
            onAction: vi.fn(),
            onLoadState: vi.fn(),
            setTitle: vi.fn(),
            saveSettings: vi.fn(),
        };
        window.electronAPI = api;
        deps = {
            media: {
                loadDiscImage: vi.fn(),
                loadTapeImage: vi.fn(),
                setProcessorTape: vi.fn(),
                setDiscImage: vi.fn(),
                setTapeImage: vi.fn(),
                addEventListener: vi.fn(),
            },
            drives: { layoutForDrive: (driveIndex) => `layout${driveIndex}`, putDiscIn: vi.fn() },
        };
    });

    afterEach(() => {
        delete window.electronAPI;
        return teardownDom();
    });

    const loadDisc = (message) => {
        initialise(deps);
        return api.onLoadDisc.mock.calls[0][0](message);
    };
    const loadTape = (message) => {
        initialise(deps);
        return api.onLoadTape.mock.calls[0][0](message);
    };

    it("does nothing outside Electron", () => {
        delete window.electronAPI;
        initialise(deps);
        expect(api.onLoadDisc).not.toHaveBeenCalled();
    });

    it("puts a disc in the drive the menu named, laid out for that drive, and names it in the URL", async () => {
        const loaded = {};
        deps.media.loadDiscImage.mockResolvedValue(loaded);
        await loadDisc({ drive: 1, path: "file:///discs/b.ssd" });
        expect(deps.media.loadDiscImage).toHaveBeenCalledWith("file:///discs/b.ssd", "layout1");
        expect(deps.drives.putDiscIn).toHaveBeenCalledWith(1, loaded);
        expect(deps.media.setDiscImage).toHaveBeenCalledWith(1, "file:///discs/b.ssd");
        expect(deps.media.setDiscImage).toHaveBeenCalledTimes(1);
    });

    it("names drive 0's disc as disc1", async () => {
        deps.media.loadDiscImage.mockResolvedValue({});
        await loadDisc({ drive: 0, path: "file:///discs/a.ssd" });
        expect(deps.media.setDiscImage).toHaveBeenCalledWith(0, "file:///discs/a.ssd");
    });

    it("reports a disc that will not load and leaves the drive and the URL alone", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        deps.media.loadDiscImage.mockRejectedValue(new Error("no such file"));
        await loadDisc({ drive: 0, path: "file:///discs/missing.ssd" });
        expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
        expect(deps.media.setDiscImage).not.toHaveBeenCalled();
        expect(toasts()).toEqual([expect.stringContaining("Could not load disc file:///discs/missing.ssd")]);
    });

    it("routes a tape to the machine and names it in the URL", async () => {
        const tape = {};
        deps.media.loadTapeImage.mockResolvedValue(tape);
        await loadTape({ path: "file:///tapes/t.uef" });
        expect(deps.media.setProcessorTape).toHaveBeenCalledWith(tape);
        expect(deps.media.setTapeImage).toHaveBeenCalledWith("file:///tapes/t.uef");
    });

    it("reports a tape that will not load", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        deps.media.loadTapeImage.mockRejectedValue(new Error("not a UEF"));
        await loadTape({ path: "file:///tapes/bad.uef" });
        expect(deps.media.setProcessorTape).not.toHaveBeenCalled();
        expect(toasts()).toEqual([expect.stringContaining("Could not load tape file:///tapes/bad.uef")]);
    });
});

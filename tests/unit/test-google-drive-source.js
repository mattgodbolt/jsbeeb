// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleDriveSource } from "../../src/web/google-drive-source.js";
import { teardownDom, toasts } from "./helpers.js";

describe("GoogleDriveSource", () => {
    let media;
    let loader;

    beforeEach(() => {
        media = { addSource: vi.fn(), addLister: vi.fn() };
        loader = {
            authorized: false,
            initialise: vi.fn().mockResolvedValue(true),
            authorize: vi.fn(async (imm) => loader.authorized || (!imm && (loader.authorized = true))),
            load: vi.fn(),
            listFiles: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
        };
        vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(teardownDom);

    const make = () => new GoogleDriveSource({ media, loader });

    describe("connecting", () => {
        it("loads the client and signs in, saying so afterwards", async () => {
            const source = make();
            expect(source.connected).toBe(false);
            expect(await source.connect()).toBe(true);
            expect(source.connected).toBe(true);
            expect(loader.authorize).toHaveBeenCalledWith(false);
        });

        it("reports a client that will not load", async () => {
            loader.initialise.mockRejectedValue(new Error("blocked"));
            expect(await make().connect()).toBe(false);
            expect(toasts()).toEqual([expect.stringContaining("Google Drive is unavailable: blocked")]);
        });

        it("reports a sign-in that fails", async () => {
            loader.authorize.mockRejectedValue(new Error("denied"));
            expect(await make().connect()).toBe(false);
            expect(toasts()).toEqual([expect.stringContaining("error accessing your Google Drive account: denied")]);
        });
    });

    describe("loading", () => {
        it("loads a file once signed in, warning when it is read only", async () => {
            loader.authorized = true;
            loader.load.mockResolvedValue({ savesChanges: false });
            const source = make();
            await source.load({ id: "abc", name: "mine.ssd" }, "auto");
            expect(loader.load).toHaveBeenCalledWith("abc", "auto");
            expect(toasts()).toEqual([expect.stringContaining("mine.ssd is read only on Google Drive")]);
        });

        it("asks for a connection rather than signing in by itself", async () => {
            await expect(make().load({ id: "abc", name: "mine.ssd" }, "auto")).rejects.toThrow(
                "Google Drive is not connected",
            );
            expect(loader.authorize).toHaveBeenCalledWith(true);
            expect(loader.load).not.toHaveBeenCalled();
        });

        it("is the drive fetcher the loader registers", async () => {
            const source = make();
            const registered = Object.fromEntries(media.addSource.mock.calls);
            expect(Object.keys(registered)).toEqual(["drive"]);
            vi.spyOn(source, "load").mockResolvedValue("a disc");
            await expect(registered.drive({ id: "abc", name: "mine.ssd" }, "auto")).resolves.toBe("a disc");
        });
    });

    describe("listing for the media window", () => {
        it("offers nothing until signed in, then every file on the Drive", async () => {
            make();
            const [name, lister] = media.addLister.mock.calls[0];
            expect(name).toBe("gdrive");
            expect(await lister()).toEqual([]);
            loader.authorized = true;
            loader.listFiles.mockResolvedValue([{ id: "abc", name: "mine.ssd", capabilities: { canEdit: true } }]);
            expect(await lister()).toEqual([
                expect.objectContaining({ ref: "gd:abc/mine.ssd", source: "gdrive", savesChanges: true }),
            ]);
        });
    });

    describe("creating a disc", () => {
        it("makes a blank formatted disc under the name, saying how the URL names it", async () => {
            loader.create.mockResolvedValue({ fileId: "xyz", disc: { name: "fresh.ssd" } });
            const { ref, disc } = await make().createBlank("fresh.ssd", "auto");
            const [name, data, layout] = loader.create.mock.calls[0];
            expect(name).toBe("fresh.ssd");
            expect(data.length).toBeGreaterThan(0);
            expect(layout).toBe("auto");
            expect(ref).toBe("gd:xyz/fresh.ssd");
            expect(disc.name).toBe("fresh.ssd");
        });

        it("refuses a blank disc whose format has no known size", async () => {
            await expect(make().createBlank("fresh.hfe", "auto")).rejects.toThrow("no known size");
            expect(loader.create).not.toHaveBeenCalled();
        });
    });
});

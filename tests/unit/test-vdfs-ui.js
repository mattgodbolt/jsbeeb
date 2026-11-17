// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachBrowserVdfs, attachVdfsMenu } from "../../src/web/vdfs-ui.js";
import { teardownDom } from "./helpers.js";

const hostWith = (store) => ({ store, flush: vi.fn(), onWriteFailure: null });
const storeIn = (state, answer = "granted") => ({
    permission: vi.fn(async () => state),
    requestPermission: vi.fn(async () => answer),
});

describe("VDFS in a browser, the page's side", () => {
    afterEach(() => {
        teardownDom();
        vi.restoreAllMocks();
    });

    describe("a folder that is being served", () => {
        let notify;
        let offer;

        beforeEach(() => {
            notify = vi.fn();
            offer = vi.fn();
        });

        it("says how to use it, and offers nothing, when the browser has said the page may", async () => {
            await attachBrowserVdfs(hostWith(storeIn("granted")), { notify, offer });
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("*VDFS"), expect.anything());
            expect(offer).not.toHaveBeenCalled();
        });

        it("offers to ask the browser again when it has to be asked, and says if it refuses", async () => {
            const store = storeIn("prompt", "denied");
            await attachBrowserVdfs(hostWith(store), { notify, offer });
            expect(notify).not.toHaveBeenCalled();
            const [, label, run] = offer.mock.calls[0];
            expect(label).toBe("Allow");
            await run();
            expect(store.requestPermission).toHaveBeenCalled();
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("did not allow"));
        });

        it("says so if the browser cannot be asked", async () => {
            const store = storeIn("prompt");
            store.requestPermission.mockRejectedValue(new Error("stale handle"));
            await attachBrowserVdfs(hostWith(store), { notify, offer });
            await offer.mock.calls[0][2]();
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("stale handle"));
        });

        it("will not say to use a folder the browser gave an answer it does not know about", async () => {
            await attachBrowserVdfs(hostWith(storeIn("sideways")), { notify, offer });
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("sideways"));
            expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("*VDFS"), expect.anything());
        });

        it("goes on to say how to use it once the browser is told", async () => {
            await attachBrowserVdfs(hostWith(storeIn("prompt", "granted")), { notify, offer });
            await offer.mock.calls[0][2]();
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("*VDFS"), expect.anything());
        });

        it.each([
            ["none", "No folder"],
            ["denied", "site settings"],
        ])("says so, without offering to ask, when the state is %s", async (state, text) => {
            await attachBrowserVdfs(hostWith(storeIn(state)), { notify, offer });
            expect(notify).toHaveBeenCalledWith(expect.stringContaining(text));
            expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("*VDFS"), expect.anything());
            expect(offer).not.toHaveBeenCalled();
        });

        it("says if the browser cannot say", async () => {
            const store = { permission: vi.fn().mockRejectedValue(new Error("stale handle")) };
            await attachBrowserVdfs(hostWith(store), { notify, offer });
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("stale handle"));
        });

        it("hands over what the BBC wrote when the page is hidden or goes, and says when it cannot be kept", async () => {
            const host = hostWith(storeIn("granted"));
            await attachBrowserVdfs(host, { notify, offer });
            window.dispatchEvent(new Event("pagehide"));
            vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
            document.dispatchEvent(new Event("visibilitychange"));
            expect(host.flush).toHaveBeenCalledTimes(2);
            host.onWriteFailure(new Error("disc full"));
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("disc full"));
        });
    });

    describe("the menu", () => {
        let folders;
        let modals;
        let urlState;
        let notify;
        let flush;
        let reloaded;

        const click = async (id) => {
            document.getElementById(id).dispatchEvent(new Event("click", { cancelable: true }));
            await new Promise((resolve) => setTimeout(resolve));
        };

        beforeEach(() => {
            document.body.innerHTML = '<a id="vdfs-serve" hidden></a><a id="vdfs-stop" hidden></a>';
            folders = {
                pick: vi.fn(async () => ({ name: "games" })),
                save: vi.fn(async () => {}),
                forget: vi.fn(async () => {}),
            };
            modals = { confirm: vi.fn(async () => true) };
            reloaded = [];
            notify = vi.fn();
            flush = vi.fn(async () => {});
            urlState = { urlWith: (params) => JSON.stringify(params) };
            vi.spyOn(window, "location", "get").mockReturnValue({
                set href(url) {
                    reloaded.push(url);
                },
            });
        });

        it("shows Serve, and Stop only when a folder is being served", () => {
            attachVdfsMenu({ urlState, modals, notify, flush, serving: false, folders });
            expect(document.getElementById("vdfs-serve").hidden).toBe(false);
            expect(document.getElementById("vdfs-stop").hidden).toBe(true);
            attachVdfsMenu({ urlState, modals, notify, flush, serving: true, folders });
            expect(document.getElementById("vdfs-stop").hidden).toBe(false);
        });

        it("hands what is open to the folder it has before it keeps another and starts again", async () => {
            const order = [];
            flush.mockImplementation(async () => order.push("flush"));
            folders.save.mockImplementation(async () => order.push("save"));
            Object.defineProperty(urlState, "urlWith", {
                value: () => {
                    order.push("reload");
                    return "x";
                },
            });
            attachVdfsMenu({ urlState, modals, notify, flush, serving: false, folders });
            await click("vdfs-serve");
            expect(order).toEqual(["flush", "save", "reload"]);
        });

        it("keeps the folder and starts again with it once the person says yes", async () => {
            attachVdfsMenu({ urlState, modals, notify, flush, serving: false, folders });
            await click("vdfs-serve");
            expect(modals.confirm).toHaveBeenCalledWith(expect.stringContaining('"games"'), "Restart", "Cancel");
            expect(folders.save).toHaveBeenCalledWith({ name: "games" });
            expect(reloaded).toHaveLength(1);
            expect(reloaded[0]).toContain('"vdfs":true');
        });

        it("keeps the folder it had, and does not restart, when the person says no or never picks one", async () => {
            attachVdfsMenu({ urlState, modals, notify, flush, serving: true, folders });
            modals.confirm.mockResolvedValue(false);
            await click("vdfs-serve");
            folders.pick.mockRejectedValue(Object.assign(new Error("closed"), { name: "AbortError" }));
            await click("vdfs-serve");
            expect(folders.save).not.toHaveBeenCalled();
            expect(folders.forget).not.toHaveBeenCalled();
            expect(reloaded).toEqual([]);
        });

        it("does not start again if the folder cannot be kept or forgotten, or the picker fails, and says so", async () => {
            attachVdfsMenu({ urlState, modals, notify, flush, serving: true, folders });
            folders.save.mockRejectedValue(new Error("no room"));
            await click("vdfs-serve");
            folders.forget.mockRejectedValue(new Error("locked"));
            await click("vdfs-stop");
            folders.pick.mockRejectedValue(new Error("not allowed"));
            await click("vdfs-serve");
            expect(reloaded).toEqual([]);
            expect(notify.mock.calls.map(([message]) => message)).toEqual([
                expect.stringContaining("no room"),
                expect.stringContaining("locked"),
                expect.stringContaining("not allowed"),
            ]);
        });

        it("says no to stopping, and forgets the folder before it starts again when told yes", async () => {
            attachVdfsMenu({ urlState, modals, notify, flush, serving: true, folders });
            modals.confirm.mockResolvedValueOnce(false);
            await click("vdfs-stop");
            expect(folders.forget).not.toHaveBeenCalled();
            const order = [];
            folders.forget.mockImplementation(async () => order.push("forget"));
            Object.defineProperty(urlState, "urlWith", {
                value: () => {
                    order.push("reload");
                    return "x";
                },
            });
            await click("vdfs-stop");
            expect(order).toEqual(["forget", "reload"]);
        });
    });
});

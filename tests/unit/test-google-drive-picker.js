// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GoogleDrivePicker } from "../../src/web/google-drive-picker.js";

const Markup = `
<a id="open-drive-link"></a>
<div id="google-drive-auth" style="display: none"><form></form></div>
<div id="google-drive" class="modal"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">
  <span class="loading"></span>
  <ul class="list"><li class="template"><span class="name"></span></li></ul>
  <form><input class="disc-name" value="" /><input type="checkbox" class="create-from-existing" /></form>
</div></div></div></div>`;

describe("GoogleDrivePicker", () => {
    let deps;
    let loader;

    beforeEach(() => {
        document.body.innerHTML = Markup;
        loader = {
            initialise: vi.fn().mockResolvedValue(true),
            authorize: vi.fn().mockResolvedValue(true),
            load: vi.fn(),
            listFiles: vi.fn().mockResolvedValue([]),
            create: vi.fn(),
        };
        deps = {
            media: { setDisc1Image: vi.fn() },
            drives: { layoutForDrive: () => "auto", putDiscIn: vi.fn() },
            modals: { popupLoading: vi.fn(), loadingFinished: vi.fn() },
            processor: { fdc: { drives: [{ disc: null }, {}] } },
            loader,
        };
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = "";
        window.localStorage.clear();
    });

    const make = () => new GoogleDrivePicker(deps);
    const toasts = () =>
        [...document.querySelectorAll(".toast")].map((el) => el.textContent.replace(/\s+/g, " ").trim());

    describe("load", () => {
        it("loads a file once signed in, through the loading dialog", async () => {
            const ssd = { savesChanges: true };
            loader.load.mockResolvedValue(ssd);
            const got = await make().load({ id: "abc", name: "mine.ssd" }, "auto");
            expect(loader.load).toHaveBeenCalledWith(deps.processor.fdc, "abc", "auto");
            expect(deps.modals.popupLoading).toHaveBeenCalledWith("Loading 'mine.ssd' from Google Drive");
            expect(deps.modals.loadingFinished).toHaveBeenCalledWith();
            expect(got).toBe(ssd);
            expect(toasts()).toEqual([]);
        });

        it("says when the loaded disc will not take changes", async () => {
            loader.load.mockResolvedValue({ savesChanges: false });
            await make().load({ id: "abc", name: "mine.ssd" }, "auto");
            expect(toasts()).toEqual([expect.stringContaining("mine.ssd is read only on Google Drive")]);
        });

        it("reports Drive being unavailable through the loading dialog", async () => {
            loader.initialise.mockResolvedValue(false);
            const got = await make().load({ id: "abc", name: "mine.ssd" }, "auto");
            expect(got).toBeUndefined();
            expect(deps.modals.loadingFinished).toHaveBeenCalledWith(
                expect.stringContaining("Unable to load mine.ssd from Google Drive"),
            );
        });

        it("shows the sign-in and carries on once the form is submitted", async () => {
            loader.authorize.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
            loader.load.mockResolvedValue({ savesChanges: true });
            const picker = make();
            const loading = picker.load({ id: "abc", name: "mine.ssd" }, "auto");
            await vi.waitFor(() => expect(document.getElementById("google-drive-auth").style.display).toBe(""));
            document.querySelector("#google-drive-auth form").dispatchEvent(new Event("submit"));
            await loading;
            expect(loader.load).toHaveBeenCalled();
            expect(document.getElementById("google-drive-auth").style.display).toBe("none");
        });
    });

    describe("signing in", () => {
        it("shows the error's message when authorization fails", async () => {
            loader.authorize.mockRejectedValue(new Error("denied"));
            await make().auth(false);
            expect(document.querySelector("#google-drive .loading").textContent).toContain(
                "There was an error accessing your Google Drive account: denied",
            );
        });
    });

    describe("the drive link", () => {
        it("keeps the link's hash out of the URL", async () => {
            const picker = make();
            const show = vi.spyOn(picker.modal, "show").mockImplementation(() => {});
            const click = new MouseEvent("click", { bubbles: true, cancelable: true });
            document.getElementById("open-drive-link").dispatchEvent(click);
            expect(click.defaultPrevented).toBe(true);
            await vi.waitFor(() => expect(show).toHaveBeenCalled());
        });
    });

    describe("the file list", () => {
        it("lists the files and loads the one clicked", async () => {
            loader.listFiles.mockResolvedValue([{ id: "abc", name: "mine.ssd" }]);
            const ssd = { savesChanges: true };
            loader.load.mockResolvedValue(ssd);
            const picker = make();
            vi.spyOn(picker.modal, "hide").mockImplementation(() => {});
            document.getElementById("google-drive").dispatchEvent(new Event("show.bs.modal"));
            await vi.waitFor(() =>
                expect(document.querySelectorAll("#google-drive li:not(.template)")).toHaveLength(1),
            );
            document.querySelector("#google-drive li:not(.template)").click();
            await vi.waitFor(() => expect(deps.drives.putDiscIn).toHaveBeenCalledWith(0, ssd));
            expect(deps.media.setDisc1Image).toHaveBeenCalledWith("gd:abc/mine.ssd");
        });

        it("says when the list cannot be fetched", async () => {
            loader.listFiles.mockRejectedValue(new Error("offline"));
            make();
            document.getElementById("google-drive").dispatchEvent(new Event("show.bs.modal"));
            await vi.waitFor(() =>
                expect(document.querySelector("#google-drive .loading").textContent).toContain(
                    "Unable to list your Google Drive files: offline",
                ),
            );
        });
    });

    describe("creating a disc", () => {
        const submit = () => document.querySelector("#google-drive form").dispatchEvent(new Event("submit"));

        it("creates a blank disc under the typed name and puts it in drive 0", async () => {
            loader.create.mockResolvedValue({ fileId: "xyz", disc: { name: "fresh.ssd" } });
            const picker = make();
            vi.spyOn(picker.modal, "hide").mockImplementation(() => {});
            document.querySelector("#google-drive .disc-name").value = "fresh.ssd";
            submit();
            await vi.waitFor(() => expect(deps.drives.putDiscIn).toHaveBeenCalled());
            const [, name, data] = loader.create.mock.calls[0];
            expect(name).toBe("fresh.ssd");
            expect(data.length).toBeGreaterThan(0);
            expect(deps.media.setDisc1Image).toHaveBeenCalledWith("gd:xyz/fresh.ssd");
        });

        it("reports a drive 0 disc that cannot be saved in the named format", async () => {
            const picker = make();
            vi.spyOn(picker.modal, "hide").mockImplementation(() => {});
            document.querySelector("#google-drive .disc-name").value = "copy.ssd";
            document.querySelector("#google-drive .create-from-existing").checked = true;
            submit();
            await vi.waitFor(() =>
                expect(deps.modals.loadingFinished).toHaveBeenCalledWith(
                    expect.stringContaining("Unable to create copy.ssd on Google Drive"),
                ),
            );
            expect(loader.create).not.toHaveBeenCalled();
        });

        it("reports a blank disc name whose format has no known size", async () => {
            const picker = make();
            vi.spyOn(picker.modal, "hide").mockImplementation(() => {});
            document.querySelector("#google-drive .disc-name").value = "fresh.hfe";
            submit();
            await vi.waitFor(() =>
                expect(deps.modals.loadingFinished).toHaveBeenCalledWith(
                    expect.stringContaining("Unable to create fresh.hfe on Google Drive"),
                ),
            );
            expect(loader.create).not.toHaveBeenCalled();
        });

        it("does nothing without a name", async () => {
            make();
            submit();
            expect(deps.modals.popupLoading).not.toHaveBeenCalled();
        });
    });
});

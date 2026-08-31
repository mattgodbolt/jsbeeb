// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SthPicker } from "../../src/web/sth-picker.js";

const Markup = `
<div id="sth" class="modal"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">
  <span class="loading"></span>
  <input id="sth-filter" value="" />
  <ul id="sth-list"><li class="template"><span class="name"></span></li></ul>
</div></div></div></div>`;

describe("SthPicker", () => {
    let deps;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = Markup;
        deps = {
            media: {
                addSource: vi.fn(),
                setDisc1Image: vi.fn(),
                setTapeImage: vi.fn(),
                loadDiscImage: vi.fn(),
                loadTapeImage: vi.fn(),
                setProcessorTape: vi.fn(),
            },
            drives: { layoutForDrive: () => "auto", putDiscIn: vi.fn() },
            modals: { popupLoading: vi.fn(), loadingFinished: vi.fn() },
            urlState: { params: {}, updateUrl: vi.fn() },
            processor: { reset: vi.fn() },
            autoboot: vi.fn(),
        };
    });

    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
        document.body.innerHTML = "";
        window.localStorage.clear();
    });

    const make = () => new SthPicker(deps);
    const rows = () => [...document.querySelectorAll("#sth-list li:not(.template)")];

    describe("rendering the catalogue", () => {
        it("renders a large catalogue a batch at a time", () => {
            const names = Array.from({ length: 250 }, (_, i) => `GAME${i}.zip`);
            make().renderCatalogue(names, () => {});
            expect(rows()).toHaveLength(100);
            vi.advanceTimersByTime(30);
            expect(rows()).toHaveLength(200);
            vi.advanceTimersByTime(30);
            expect(rows()).toHaveLength(250);
        });

        it("renders every batch honouring the filter already typed", () => {
            document.getElementById("sth-filter").value = "ELITE";
            const names = ["ELITE.zip", ...Array.from({ length: 150 }, (_, i) => `GAME${i}.zip`)];
            make().renderCatalogue(names, () => {});
            vi.runAllTimers();
            expect(rows()).toHaveLength(151);
            const shown = rows().filter((row) => row.style.display !== "none");
            expect(shown.map((row) => row.textContent)).toEqual(["ELITE.zip"]);
        });

        it("re-filters what is already on screen as the user types", () => {
            make().renderCatalogue(["ELITE.zip", "CHUCKIE.zip"], () => {});
            const filter = document.getElementById("sth-filter");
            filter.value = "chuckie";
            filter.dispatchEvent(new Event("keyup"));
            const shown = rows().filter((row) => row.style.display !== "none");
            expect(shown.map((row) => row.textContent)).toEqual(["CHUCKIE.zip"]);
        });

        it("hides the loading text once the catalogue is up", () => {
            document.querySelector("#sth .loading").style.display = "";
            make().renderCatalogue(["A.zip"], () => {});
            expect(document.querySelector("#sth .loading").style.display).toBe("none");
        });

        it("gives up a stale render when the list is cleared under it", () => {
            const picker = make();
            picker.renderCatalogue(
                Array.from({ length: 150 }, (_, i) => `GAME${i}.zip`),
                () => {},
            );
            expect(rows()).toHaveLength(100);
            picker.renderCatalogue(["ONLY.zip"], () => {});
            vi.runAllTimers();
            // The first chain's second batch must not append to the new list.
            expect(rows()).toHaveLength(1);
            expect(rows()[0].querySelector(".name").textContent).toBe("ONLY.zip");
        });

        it("answers a click with the name and puts the modal away", () => {
            const onClick = vi.fn();
            const picker = make();
            const hide = vi.spyOn(picker.modal, "hide").mockImplementation(() => {});
            picker.renderCatalogue(["ELITE.zip"], onClick);
            rows()[0].click();
            expect(onClick).toHaveBeenCalledWith("ELITE.zip");
            expect(hide).toHaveBeenCalled();
        });
    });

    describe("picking a disc", () => {
        it("names it in the URL, loads it into drive 0 and closes the loading dialog", async () => {
            const loaded = {};
            deps.media.setDisc1Image.mockImplementation((name) => (deps.urlState.params.disc1 = name));
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await make().pickDisc("ELITE.zip");
            expect(deps.media.setDisc1Image).toHaveBeenCalledWith("sth:ELITE.zip");
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("sth:ELITE.zip", "auto");
            expect(deps.drives.putDiscIn).toHaveBeenCalledWith(0, loaded);
            expect(deps.modals.loadingFinished).toHaveBeenCalledWith();
            expect(deps.processor.reset).not.toHaveBeenCalled();
            expect(deps.autoboot).not.toHaveBeenCalled();
        });

        it("resets and autoboots when the tick is on", async () => {
            deps.urlState.params.autoboot = "";
            deps.media.loadDiscImage.mockResolvedValue({});
            await make().pickDisc("ELITE.zip");
            expect(deps.processor.reset).toHaveBeenCalledWith(true);
            expect(deps.autoboot).toHaveBeenCalledWith("ELITE.zip");
        });

        it("reports a failure through the loading dialog", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.media.loadDiscImage.mockRejectedValue(new Error("404"));
            await make().pickDisc("ELITE.zip");
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
            expect(deps.modals.loadingFinished).toHaveBeenCalledWith(
                expect.stringContaining("Unable to load ELITE.zip from the STH archive: 404"),
            );
        });
    });

    describe("picking a tape", () => {
        it("names it in the URL and routes it to the machine", async () => {
            const tape = {};
            deps.media.setTapeImage.mockImplementation((name) => (deps.urlState.params.tape = name));
            deps.media.loadTapeImage.mockResolvedValue(tape);
            await make().pickTape("CHUCKIE.zip");
            expect(deps.media.setTapeImage).toHaveBeenCalledWith("sth:CHUCKIE.zip");
            expect(deps.media.loadTapeImage).toHaveBeenCalledWith("sth:CHUCKIE.zip");
            expect(deps.media.setProcessorTape).toHaveBeenCalledWith(tape);
        });

        it("reports a failure through the loading dialog", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.media.loadTapeImage.mockRejectedValue(new Error("410"));
            await make().pickTape("CHUCKIE.zip");
            expect(deps.media.setProcessorTape).not.toHaveBeenCalled();
            expect(deps.modals.loadingFinished).toHaveBeenCalledWith(
                expect.stringContaining("Unable to load CHUCKIE.zip from the STH archive: 410"),
            );
        });
    });

    describe("registering media sources", () => {
        it("hands the loader a fetcher for each catalogue", async () => {
            const picker = make();
            const registered = Object.fromEntries(deps.media.addSource.mock.calls);
            expect(Object.keys(registered).sort()).toEqual(["sth", "tapeSth"]);
            vi.spyOn(picker.discs, "fetch").mockResolvedValue("disc bytes");
            vi.spyOn(picker.tapes, "fetch").mockResolvedValue("tape bytes");
            await expect(registered.sth("ELITE.zip")).resolves.toBe("disc bytes");
            expect(picker.discs.fetch).toHaveBeenCalledWith("ELITE.zip");
            await expect(registered.tapeSth("CHUCKIE.zip")).resolves.toBe("tape bytes");
            expect(picker.tapes.fetch).toHaveBeenCalledWith("CHUCKIE.zip");
        });
    });
});

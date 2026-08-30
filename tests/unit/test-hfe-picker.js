// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HfePicker } from "../../src/web/hfe-picker.js";
import { Provenance } from "../../src/bbcdiscs.js";

const Markup = `
<div id="hfe" class="modal"><div class="modal-dialog"><div class="modal-content"><div class="modal-body">
  <span class="loading"></span>
  <input id="hfe-filter" value="" />
  <div id="hfe-provenance"></div>
  <ul id="hfe-list"><li class="template"><a href="#">
    <span class="name"></span><span class="publisher"></span><span class="detail"></span><span class="provenance"></span>
  </a></li></ul>
</div></div></div></div>`;

const entry = (path, title, provenance = Provenance.Captured, extra = {}) => ({
    path,
    title,
    publisher: "Acornsoft",
    disc: "D1S1",
    tracks: [80],
    provenance,
    ...extra,
});

describe("HfePicker", () => {
    let deps;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = Markup;
        deps = {
            media: { setDisc1Image: vi.fn(), loadDiscImage: vi.fn() },
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

    const make = () => new HfePicker(deps);
    const rows = () => [...document.querySelectorAll("#hfe-list li:not(.template)")];
    const shownRows = () => rows().filter((row) => row.style.display !== "none");

    describe("rendering the catalogue", () => {
        it("renders a large catalogue a batch at a time", () => {
            const picker = make();
            picker.renderCatalogue(Array.from({ length: 150 }, (_, i) => entry(`G${i}.hfe`, `Game ${i}`)));
            expect(rows()).toHaveLength(100);
            vi.advanceTimersByTime(30);
            expect(rows()).toHaveLength(150);
        });

        it("gives up a stale render when the list is cleared under it", () => {
            const picker = make();
            picker.renderCatalogue(Array.from({ length: 150 }, (_, i) => entry(`G${i}.hfe`, `Game ${i}`)));
            expect(rows()).toHaveLength(100);
            picker.renderCatalogue([entry("ONLY.hfe", "Only")]);
            vi.runAllTimers();
            // The first chain's second batch must not append to the new list.
            expect(rows()).toHaveLength(1);
            expect(rows()[0].querySelector(".name").textContent).toBe("Only");
        });

        it("marks reconstructed discs and carries notes as a tooltip", () => {
            make().renderCatalogue([
                entry("A.hfe", "Captured One"),
                entry("B.hfe", "Rebuilt One", Provenance.Reconstructed, { notes: "from a sector dump" }),
            ]);
            const [captured, rebuilt] = rows();
            expect(captured.querySelector(".provenance").textContent).toBe("");
            expect(rebuilt.querySelector(".provenance").textContent).toBe("reconstructed");
            expect(rebuilt.title).toBe("from a sector dump");
        });
    });

    describe("provenance choices", () => {
        const boxes = () => [...document.querySelectorAll("#hfe-provenance input")];

        it("offers no choice when the archive holds only one provenance", () => {
            make().renderCatalogue([entry("A.hfe", "A"), entry("B.hfe", "B")]);
            expect(boxes()).toHaveLength(0);
        });

        it("offers one tick per provenance present, all on to begin with", () => {
            make().renderCatalogue([entry("A.hfe", "A"), entry("B.hfe", "B", Provenance.Reconstructed)]);
            expect(boxes().map((box) => box.value)).toEqual([Provenance.Captured, Provenance.Reconstructed]);
            expect(boxes().every((box) => box.checked)).toBe(true);
        });

        it("hides rows whose provenance is unticked", () => {
            make().renderCatalogue([entry("A.hfe", "A"), entry("B.hfe", "B", Provenance.Reconstructed)]);
            const reconstructed = boxes().find((box) => box.value === Provenance.Reconstructed);
            reconstructed.checked = false;
            reconstructed.dispatchEvent(new Event("change"));
            expect(shownRows().map((row) => row.querySelector(".name").textContent)).toEqual(["A"]);
        });

        it("keeps the user's ticks across a re-render", () => {
            const picker = make();
            const catalogue = [entry("A.hfe", "A"), entry("B.hfe", "B", Provenance.Reconstructed)];
            picker.renderCatalogue(catalogue);
            const reconstructed = boxes().find((box) => box.value === Provenance.Reconstructed);
            reconstructed.checked = false;
            picker.renderCatalogue(catalogue);
            expect(boxes().find((box) => box.value === Provenance.Reconstructed).checked).toBe(false);
        });
    });

    describe("the filter box", () => {
        it("re-filters what is on screen as the user types", () => {
            make().renderCatalogue([entry("A.hfe", "Elite"), entry("B.hfe", "Chuckie Egg")]);
            const filter = document.getElementById("hfe-filter");
            filter.value = "chuckie";
            filter.dispatchEvent(new Event("keyup"));
            expect(shownRows().map((row) => row.querySelector(".name").textContent)).toEqual(["Chuckie Egg"]);
        });
    });

    describe("picking a disc", () => {
        it("does not let the row's anchor navigate", () => {
            deps.media.loadDiscImage.mockResolvedValue({});
            const picker = make();
            vi.spyOn(picker.modal, "hide").mockImplementation(() => {});
            picker.renderCatalogue([entry("A.hfe", "Elite")]);
            const click = new MouseEvent("click", { bubbles: true, cancelable: true });
            rows()[0].dispatchEvent(click);
            expect(click.defaultPrevented).toBe(true);
        });

        it("names it in the URL, loads it and closes the loading dialog", async () => {
            const loaded = {};
            deps.media.setDisc1Image.mockImplementation((name) => (deps.urlState.params.disc1 = name));
            deps.media.loadDiscImage.mockResolvedValue(loaded);
            await make().pick(entry("Games/ELITE.hfe", "Elite"));
            expect(deps.media.setDisc1Image).toHaveBeenCalledWith("hfe:Games/ELITE.hfe");
            expect(deps.media.loadDiscImage).toHaveBeenCalledWith("hfe:Games/ELITE.hfe", "auto");
            expect(deps.drives.putDiscIn).toHaveBeenCalledWith(0, loaded);
            expect(deps.modals.loadingFinished).toHaveBeenCalledWith();
        });

        it("resets and autoboots by title when the tick is on", async () => {
            deps.urlState.params.autoboot = "";
            deps.media.loadDiscImage.mockResolvedValue({});
            await make().pick(entry("A.hfe", "Elite"));
            expect(deps.processor.reset).toHaveBeenCalledWith(true);
            expect(deps.autoboot).toHaveBeenCalledWith("Elite");
        });

        it("reports a failure through the loading dialog", async () => {
            vi.spyOn(console, "error").mockImplementation(() => {});
            deps.media.loadDiscImage.mockRejectedValue(new Error("404"));
            await make().pick(entry("A.hfe", "Elite"));
            expect(deps.drives.putDiscIn).not.toHaveBeenCalled();
            expect(deps.modals.loadingFinished).toHaveBeenCalledWith(
                expect.stringContaining("Unable to load Elite from the HFE archive: 404"),
            );
        });
    });
});

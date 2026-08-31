// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AutobootTicks, clearArchiveList, filterArchiveList, showArchiveMessage } from "../../src/web/archive-list.js";
import { domFromIndexHtml, fakeUrlState, teardownDom } from "./helpers.js";

const addRow = (listId, text) => {
    const row = document.createElement("li");
    row.textContent = text;
    document.getElementById(listId).appendChild(row);
    return row;
};

describe("archive lists", () => {
    beforeEach(() => {
        domFromIndexHtml("sth", "hfe");
    });

    afterEach(teardownDom);

    it("clears every row but the template", () => {
        addRow("sth-list", "Elite");
        addRow("sth-list", "Chuckie Egg");
        clearArchiveList("sth-list");
        expect(document.querySelectorAll("#sth-list li")).toHaveLength(1);
        expect(document.querySelector("#sth-list .template")).toBeTruthy();
    });

    it("shows a message and empties the list it talks about", () => {
        addRow("sth-list", "Elite");
        showArchiveMessage("sth", "sth-list", "Loading catalog from STH archive");
        const loading = document.querySelector("#sth .loading");
        expect(loading.textContent).toBe("Loading catalog from STH archive");
        expect(loading.style.display).toBe("");
        expect(document.querySelectorAll("#sth-list li:not(.template)")).toHaveLength(0);
    });

    it("filters rows by their text, without regard to case", () => {
        const elite = addRow("sth-list", "Elite");
        const chuckie = addRow("sth-list", "Chuckie Egg");
        filterArchiveList("sth-list", "ELITE");
        expect(elite.style.display).toBe("");
        expect(chuckie.style.display).toBe("none");
        filterArchiveList("sth-list", "");
        expect(chuckie.style.display).toBe("");
    });

    describe("AutobootTicks", () => {
        let urlState;
        const boxes = () => [...document.querySelectorAll(".autoboot")];

        beforeEach(() => {
            urlState = fakeUrlState();
            new AutobootTicks({ urlState });
        });

        it("mirrors a tick into every picker and the URL", () => {
            boxes()[0].click();
            expect(boxes().map((box) => box.checked)).toEqual([true, true]);
            expect(urlState.url()).toBe("https://bbc.example/?autoboot");
            expect(urlState.history.pushState).toHaveBeenCalledTimes(1);
        });

        it("clears the URL when unticked from the other picker", () => {
            boxes()[0].click();
            boxes()[1].click();
            expect(boxes().map((box) => box.checked)).toEqual([false, false]);
            expect(urlState.url()).toBe("https://bbc.example/");
        });

        it("can be shown a state without touching the URL", () => {
            const ticks = new AutobootTicks({ urlState });
            ticks.show(true);
            expect(boxes().every((box) => box.checked)).toBe(true);
            expect(urlState.history.pushState).not.toHaveBeenCalled();
        });
    });
});

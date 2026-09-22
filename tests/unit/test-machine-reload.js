// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { leaveForNextPage, reloadAsMachine, takeFromLastPage } from "../../src/web/machine-reload.js";
import { fakeUrlState, stubNavigation, teardownDom } from "./helpers.js";

describe("reloading as another machine", () => {
    afterEach(() => {
        window.history.replaceState(null, "", window.location.pathname);
        sessionStorage.clear();
        return teardownDom();
    });

    const pageThatDidThings = () =>
        stubNavigation(
            fakeUrlState(
                "?disc1=elite.ssd&autoboot&autochain&autorun&autotype=RUN&loadBasic=a.bas&embedBasic=1&patch=@1",
            ),
        );

    it("keeps the page's media and drops what it did at startup, unless the caller asks again", () => {
        const urlState = pageThatDidThings();
        reloadAsMachine(urlState, { model: "Master", coProcessor: true });
        expect(urlState.navigatedTo).toBe("https://bbc.example/?disc1=elite.ssd&model=Master&coProcessor");
        reloadAsMachine(urlState, { model: "Master", coProcessor: false, autoboot: true });
        expect(urlState.navigatedTo).toBe("https://bbc.example/?disc1=elite.ssd&autoboot&model=Master");
    });

    it("pushes a history entry unless told to replace the page", () => {
        const urlState = pageThatDidThings();
        const entries = window.history.length;
        reloadAsMachine(urlState, { model: "Master" }, { replace: true });
        expect(window.history.length).toBe(entries);
        reloadAsMachine(urlState, { model: "Master" });
        expect(window.history.length).toBe(entries + 1);
    });

    it("hands a value to the next page exactly once", () => {
        expect(takeFromLastPage("jsbeeb-test")).toBeNull();
        leaveForNextPage("jsbeeb-test", "");
        expect(takeFromLastPage("jsbeeb-test")).toBe("");
        expect(takeFromLastPage("jsbeeb-test")).toBeNull();
    });
});

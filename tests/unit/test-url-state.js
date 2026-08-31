import { beforeEach, describe, expect, it, vi } from "vitest";

import { UrlState, UrlParamTypes } from "../../src/web/url-state.js";
import { ParamTypes } from "../../src/url-params.js";

const location = (search, hash = "") => ({ origin: "https://bbc.example", pathname: "/play", search, hash });

describe("UrlState", () => {
    let history;

    beforeEach(() => {
        history = { pushState: vi.fn() };
    });

    it("parses the query string using the page's parameter types", () => {
        const state = new UrlState(location("?model=Master&frameSkip=2&autoboot&rom=a.rom&rom=b.rom"), history);
        expect(state.params.model).toBe("Master");
        expect(state.params.frameSkip).toBe(2);
        expect(state.params.autoboot).toBe(true);
        expect(state.params.rom).toEqual(["a.rom", "b.rom"]);
    });

    it("takes parameters from after the hash as well", () => {
        const state = new UrlState(location("?model=Master", "#disc=elite.ssd&autoboot"), history);
        expect(state.params.disc).toBe("elite.ssd");
        expect(state.params.autoboot).toBe(true);
    });

    it("pushes the current parameters onto the history as the page's URL", () => {
        const state = new UrlState(location("?model=Master"), history);
        state.params.disc1 = "sth:Elite.zip";
        delete state.params.model;
        state.updateUrl();
        expect(history.pushState).toHaveBeenCalledWith(null, null, "https://bbc.example/play?disc1=sth:Elite.zip");
    });

    it("applies changes and pushes the new URL in one step", () => {
        const state = new UrlState(location("?model=B"), history);
        state.set({ model: "Master", disc1: "sth:Elite.zip" });
        expect(state.params).toEqual({ model: "Master", disc1: "sth:Elite.zip" });
        expect(history.pushState).toHaveBeenCalledTimes(1);
        expect(history.pushState).toHaveBeenCalledWith(
            null,
            null,
            "https://bbc.example/play?model=Master&disc1=sth:Elite.zip",
        );
    });

    it("deletes a parameter set to undefined", () => {
        const state = new UrlState(location("?model=B&disc=elite.ssd"), history);
        state.set({ disc: undefined });
        expect(state.params).toEqual({ model: "B" });
        expect(history.pushState).toHaveBeenCalledWith(null, null, "https://bbc.example/play?model=B");
    });

    it("builds a URL with overrides without changing the parameters it holds", () => {
        const state = new UrlState(location("?model=B&disc=elite.ssd"), history);
        const url = state.urlWith({ model: "Master", coProcessor: true });
        expect(url).toContain("model=Master");
        expect(url).toContain("coProcessor");
        expect(url).toContain("disc=elite.ssd");
        expect(state.params.model).toBe("B");
        expect(state.params.coProcessor).toBeUndefined();
        expect(history.pushState).not.toHaveBeenCalled();
    });

    it("keeps one parameters object for everyone to share", () => {
        const state = new UrlState(location(""), history);
        const params = state.params;
        params.tape = "sth:Chuckie.zip";
        expect(state.params).toBe(params);
        expect(state.url()).toContain("tape=sth:Chuckie.zip");
    });

    it("types every parameter it lists", () => {
        for (const [name, type] of Object.entries(UrlParamTypes)) {
            expect(Object.values(ParamTypes), name).toContain(type);
        }
    });
});

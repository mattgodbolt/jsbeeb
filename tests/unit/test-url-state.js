import { beforeEach, describe, expect, it, vi } from "vitest";

import { UrlState } from "../../src/web/url-state.js";
import { Parameters } from "../../src/web/parameters.js";
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

    it("lets a settling burst of changes finish before pushing one URL", () => {
        vi.useFakeTimers();
        try {
            const state = new UrlState(location("?model=B"), history);
            state.set({ speakerAmount: 0.5 }, { settle: true });
            state.set({ speakerAmount: 0.3 }, { settle: true });
            expect(state.params.speakerAmount).toBe(0.3);
            expect(history.pushState).not.toHaveBeenCalled();
            vi.runAllTimers();
            expect(history.pushState).toHaveBeenCalledTimes(1);
            expect(history.pushState).toHaveBeenCalledWith(null, null, expect.stringContaining("speakerAmount=0.3"));
        } finally {
            vi.useRealTimers();
        }
    });

    it("makes no history for a change that changes nothing", () => {
        const state = new UrlState(location("?disc1=a.ssd"), history);
        state.set({ disc1: "a.ssd", tape: undefined });
        expect(history.pushState).not.toHaveBeenCalled();
        state.set({ disc1: "b.ssd" });
        expect(history.pushState).toHaveBeenCalledTimes(1);
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

    it("gives back every parameter it lists as it was given", () => {
        const samples = {
            [ParamTypes.STRING]: (name) => `${name}=sth:Elite.zip`,
            [ParamTypes.ARRAY]: (name) => `${name}=a.rom&${name}=b.rom`,
            [ParamTypes.INT]: (name) => `${name}=3`,
            [ParamTypes.FLOAT]: (name) => `${name}=0.25`,
            [ParamTypes.BOOL]: (name) => name,
            [ParamTypes.BOOL_DEFAULT_TRUE]: (name) => `${name}=false`,
        };
        const query = Object.entries(Parameters)
            .filter(([, { prefix }]) => !prefix)
            .map(([name, { type }]) => samples[type](name))
            .join("&");
        expect(new UrlState(location(`?${query}`), history).url()).toBe(`https://bbc.example/play?${query}`);
    });

    it("gives back the key and gamepad mappings as they were spelled", () => {
        const query = "KEY.CAPSLOCK=CTRL&key.f1=COPY&GP.FIRE2=RETURN&gp.fire1=SPACE&FIRE=SPACE";
        const state = new UrlState(location(`?${query}`), history);
        expect(state.params).toMatchObject({ "key.f1": "COPY", "gp.fire1": "SPACE", FIRE: "SPACE" });
        expect(state.url()).toBe(`https://bbc.example/play?${query}`);
    });
});

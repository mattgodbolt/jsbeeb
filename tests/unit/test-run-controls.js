// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunControls } from "../../src/web/run-controls.js";
import { domFromIndexHtml, teardownDom } from "./helpers.js";

class FakeLoop extends EventTarget {
    constructor() {
        super();
        this.running = false;
    }

    isRunning() {
        return this.running;
    }

    go() {
        this.running = true;
        this.dispatchEvent(new Event("running"));
    }

    stop() {
        this.running = false;
        this.dispatchEvent(new Event("running"));
    }
}

describe("RunControls", () => {
    let loop;
    let dbgr;
    let keys;
    let controls;

    const playButton = () => document.getElementById("debug-play");
    const pauseButton = () => document.getElementById("debug-pause");

    beforeEach(() => {
        domFromIndexHtml("debug-pause", "debug-play");
        loop = new FakeLoop();
        dbgr = { hide: vi.fn() };
        // In the app, resumeEmulation restarts the loop through the keyboard's resume event.
        keys = { setRunning: vi.fn(), resumeEmulation: vi.fn(() => loop.go()) };
        controls = new RunControls({ loop, dbgr, keys });
    });

    afterEach(teardownDom);

    it("pause stops the loop into the debugger", () => {
        loop.go();
        const stop = vi.spyOn(loop, "stop");
        pauseButton().click();
        expect(stop).toHaveBeenCalledWith(true);
        expect(loop.isRunning()).toBe(false);
    });

    it("play hides the debugger and resumes through the keyboard", () => {
        playButton().click();
        expect(dbgr.hide).toHaveBeenCalled();
        expect(keys.resumeEmulation).toHaveBeenCalled();
        expect(loop.isRunning()).toBe(true);
    });

    it("the buttons' disabled states track the loop's running state", () => {
        loop.go();
        expect(playButton().disabled).toBe(true);
        expect(pauseButton().disabled).toBe(false);
        loop.stop();
        expect(playButton().disabled).toBe(false);
        expect(pauseButton().disabled).toBe(true);
    });

    it("tells the keyboard the running state", () => {
        loop.go();
        expect(keys.setRunning).toHaveBeenLastCalledWith(true);
        loop.stop();
        expect(keys.setRunning).toHaveBeenLastCalledWith(false);
    });

    it("pause and resume work without the buttons, for the desktop app's menu", () => {
        const stop = vi.spyOn(loop, "stop");
        controls.pause();
        expect(stop).toHaveBeenCalledWith(true);
        controls.resume();
        expect(dbgr.hide).toHaveBeenCalled();
        expect(loop.isRunning()).toBe(true);
    });
});

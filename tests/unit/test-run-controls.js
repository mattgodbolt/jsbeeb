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

    const playButton = () => document.getElementById("debug-play");
    const pauseButton = () => document.getElementById("debug-pause");

    beforeEach(() => {
        domFromIndexHtml("debug-pause", "debug-play");
        loop = new FakeLoop();
        new RunControls({ loop });
    });

    afterEach(teardownDom);

    it("pause stops the loop into the debugger", () => {
        loop.go();
        const stop = vi.spyOn(loop, "stop");
        pauseButton().click();
        expect(stop).toHaveBeenCalledWith(true);
        expect(loop.isRunning()).toBe(false);
    });

    it("play starts the loop", () => {
        playButton().click();
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
});

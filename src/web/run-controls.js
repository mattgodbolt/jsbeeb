"use strict";

/**
 * The play and pause buttons on the top bar, kept in step with the loop's
 * running state. pause() and resume() are also the desktop app's menu actions.
 */
export class RunControls {
    /**
     * @param {object} options
     * @param {object} options.loop - the emulation loop
     * @param {object} options.dbgr - the debugger, hidden on resume
     * @param {object} options.keys - the keyboard setup, told the running state
     */
    constructor({ loop, dbgr, keys }) {
        this.loop = loop;
        this.dbgr = dbgr;
        this.keys = keys;
        this.playButton = document.getElementById("debug-play");
        this.pauseButton = document.getElementById("debug-pause");

        loop.addEventListener("running", () => {
            const running = loop.isRunning();
            keys.setRunning(running);
            this.playButton.disabled = running;
            this.pauseButton.disabled = !running;
        });
        this.pauseButton.addEventListener("click", () => this.pause());
        this.playButton.addEventListener("click", () => this.resume());
    }

    /** Stop the loop into the debugger. */
    pause() {
        this.loop.stop(true);
    }

    /** Hide the debugger; the keyboard's resume event restarts the loop. */
    resume() {
        this.dbgr.hide();
        this.keys.resumeEmulation();
    }
}

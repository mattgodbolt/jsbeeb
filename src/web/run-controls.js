/** The play and pause buttons on the top bar, kept in step with the loop's running state. */
export class RunControls {
    /**
     * @param {object} options
     * @param {object} options.loop - the emulation loop
     */
    constructor({ loop }) {
        const playButton = document.getElementById("debug-play");
        const pauseButton = document.getElementById("debug-pause");
        loop.addEventListener("running", () => {
            playButton.disabled = loop.isRunning();
            pauseButton.disabled = !loop.isRunning();
        });
        pauseButton.addEventListener("click", () => loop.stop(true));
        playButton.addEventListener("click", () => loop.go());
    }
}

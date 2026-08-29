import { AudioOutputs } from "../audio-output.js";

/** The sound output, speaker amount and display mode controls on the top bar. */
export class QuickSettings {
    constructor({ audioHandler, onDisplayMode, storage }, { audioOutput, speakerAmount, displayMode }) {
        this.output = document.getElementById("audio-output");
        this.amount = document.getElementById("speaker-amount");
        this.display = document.getElementById("display-mode");
        if (!this.output || !this.amount || !this.display) return;

        this.amount.value = speakerAmount;
        this._showOutput(audioOutput);
        this.showDisplayMode(displayMode);

        this.output.addEventListener("click", (e) => {
            const value = e.target.closest("[data-output]")?.dataset.output;
            if (!value) return;
            audioHandler.setAudioOutput(value);
            storage.audioOutput = value;
            this._showOutput(value);
        });
        this.amount.addEventListener("input", () => audioHandler.setSpeakerAmount(parseFloat(this.amount.value)));
        this.amount.addEventListener("change", () => (storage.speakerAmount = this.amount.value));
        this.display.addEventListener("click", (e) => {
            const mode = e.target.closest("[data-mode]")?.dataset.mode;
            if (mode) onDisplayMode(mode);
        });
    }

    _showOutput(audioOutput) {
        select(this.output.querySelectorAll("[data-output]"), (b) => b.dataset.output === audioOutput);
        this.amount.disabled = audioOutput !== AudioOutputs.speaker;
    }

    showDisplayMode(mode) {
        if (this.display) select(this.display.querySelectorAll("[data-mode]"), (b) => b.dataset.mode === mode);
    }
}

function select(buttons, isChosen) {
    for (const button of buttons) {
        const chosen = isChosen(button);
        button.classList.toggle("active", chosen);
        button.setAttribute("aria-pressed", chosen);
    }
}

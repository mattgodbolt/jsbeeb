import { AudioOutputs } from "../audio-output.js";

/** The sound output, speaker amount and display mode controls on the top bar. */
export class QuickSettings {
    constructor({ audioHandler, onDisplayMode, storage }, { audioOutput, speakerAmount, displayMode }) {
        this.output = document.getElementById("audio-output");
        this.amount = document.getElementById("speaker-amount");
        this.display = document.getElementById("display-mode");
        if (!this.output || !this.amount || !this.display) return;

        this.output.value = audioOutput;
        this.amount.value = speakerAmount;
        this.display.value = displayMode;
        this._showAmountFor(audioOutput);

        this.output.addEventListener("change", () => {
            const value = this.output.value;
            audioHandler.setAudioOutput(value);
            storage.audioOutput = value;
            this._showAmountFor(value);
        });
        this.amount.addEventListener("input", () => audioHandler.setSpeakerAmount(parseFloat(this.amount.value)));
        this.amount.addEventListener("change", () => (storage.speakerAmount = this.amount.value));
        this.display.addEventListener("change", () => onDisplayMode(this.display.value));
    }

    _showAmountFor(audioOutput) {
        this.amount.disabled = audioOutput !== AudioOutputs.speaker;
    }

    showDisplayMode(mode) {
        if (this.display) this.display.value = mode;
    }
}

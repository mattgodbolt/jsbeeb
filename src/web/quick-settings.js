import { AudioOutputs } from "../audio-output.js";

/**
 * The sound output, speaker amount and display mode controls on the top bar.
 * Choices go to the callbacks; what is shown follows the show methods, so the
 * bar can be kept in step with the same settings elsewhere.
 */
export class QuickSettings {
    constructor({ onAudioOutput, onSpeakerAmount, onDisplayMode }, { audioOutput, speakerAmount, displayMode }) {
        this.output = document.getElementById("audio-output");
        this.amount = document.getElementById("speaker-amount");
        this.display = document.getElementById("display-mode");
        if (!this.output || !this.amount || !this.display) return;

        this.showAudioOutput(audioOutput);
        this.showSpeakerAmount(speakerAmount);
        this.showDisplayMode(displayMode);

        this.output.addEventListener("click", (e) => {
            const value = e.target.closest("[data-output]")?.dataset.output;
            if (value) onAudioOutput(value);
        });
        this.amount.addEventListener("input", () => onSpeakerAmount(parseFloat(this.amount.value)));
        this.display.addEventListener("click", (e) => {
            const mode = e.target.closest("[data-mode]")?.dataset.mode;
            if (mode) onDisplayMode(mode);
        });
    }

    showAudioOutput(audioOutput) {
        if (!this.output) return;
        select(this.output.querySelectorAll("[data-output]"), (b) => b.dataset.output === audioOutput);
        this.amount.disabled = audioOutput !== AudioOutputs.speaker;
    }

    showSpeakerAmount(speakerAmount) {
        if (this.amount) this.amount.value = speakerAmount;
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

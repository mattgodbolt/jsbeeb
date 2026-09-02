import { AudioOutputs } from "../audio-output.js";

/**
 * The sound output, speaker amount and display mode controls on the top bar:
 * a view of those three settings, and a way to set them.
 */
export class QuickSettings {
    constructor(settings) {
        this.output = document.getElementById("audio-output");
        this.amount = document.getElementById("speaker-amount");
        this.display = document.getElementById("display-mode");
        if (!this.output || !this.amount || !this.display) return;

        this.showAudioOutput(settings.audioOutput);
        this.showSpeakerAmount(settings.speakerAmount);
        this.showDisplayMode(settings.displayMode);
        settings.on("audioOutput", (audioOutput) => this.showAudioOutput(audioOutput));
        settings.on("speakerAmount", (speakerAmount) => this.showSpeakerAmount(speakerAmount));
        settings.on("displayMode", (displayMode) => this.showDisplayMode(displayMode));

        this.output.addEventListener("click", (e) => {
            const audioOutput = e.target.closest("[data-output]")?.dataset.output;
            if (audioOutput) settings.set({ audioOutput });
        });
        this.amount.addEventListener("input", () => settings.set({ speakerAmount: parseFloat(this.amount.value) }));
        this.display.addEventListener("click", (e) => {
            const displayMode = e.target.closest("[data-mode]")?.dataset.mode;
            if (displayMode) settings.set({ displayMode });
        });
    }

    showAudioOutput(audioOutput) {
        select(this.output.querySelectorAll("[data-output]"), (b) => b.dataset.output === audioOutput);
        this.amount.disabled = audioOutput !== AudioOutputs.speaker;
    }

    showSpeakerAmount(speakerAmount) {
        this.amount.value = speakerAmount;
    }

    showDisplayMode(mode) {
        select(this.display.querySelectorAll("[data-mode]"), (b) => b.dataset.mode === mode);
    }
}

function select(buttons, isChosen) {
    for (const button of buttons) {
        const chosen = isChosen(button);
        button.classList.toggle("active", chosen);
        button.setAttribute("aria-pressed", chosen);
    }
}

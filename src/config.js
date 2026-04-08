"use strict";
import { allModels, findModel } from "./models.js";
import { getFilterForMode } from "./canvas.js";

export class Config extends EventTarget {
    constructor(onChange, onClose) {
        super();
        this.onChange = onChange;
        this.onClose = onClose;
        this.changed = {};
        this.model = null;
        this.coProcessor = null;
        const configuration = document.getElementById("configuration");
        configuration.addEventListener("show.bs.modal", () => {
            this.changed = {};
            this.setDropdownText(this.model.name);
            this.set65c02(this.model.tube);
            this.setTubeCpuMultiplier(this.tubeCpuMultiplier);
            this.setTeletext(this.model.hasTeletextAdaptor);
            this.setMusic5000(this.model.hasMusic5000);
            this.setEconet(this.model.hasEconet);
        });

        configuration.addEventListener("hide.bs.modal", () => {
            this.onClose(this.changed);
            if (Object.keys(this.changed).length > 0) {
                this.dispatchEvent(new CustomEvent("settings-changed", { detail: this.changed }));
            }
        });

        const modelMenu = document.querySelector(".model-menu");
        for (const model of allModels) {
            if (model.synonyms.length === 0) continue; // skip non-selectable models (e.g. Tube65C02)
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.href = "#";
            a.className = "dropdown-item";
            a.dataset.target = model.synonyms[0];
            a.textContent = model.name;
            li.appendChild(a);
            modelMenu.appendChild(li);
        }
        modelMenu.addEventListener("click", (e) => {
            const link = e.target.closest("a[data-target]");
            if (!link) return;
            this.changed.model = link.dataset.target;
            this.setDropdownText(link.textContent);
        });

        document.getElementById("65c02").addEventListener("click", () => {
            this.changed.coProcessor = document.getElementById("65c02").checked;
            document.getElementById("tubeCpuMultiplier").disabled = !document.getElementById("65c02").checked;
        });

        document.getElementById("tubeCpuMultiplier").addEventListener("input", () => {
            const val = parseInt(document.getElementById("tubeCpuMultiplier").value, 10);
            document.getElementById("tubeCpuMultiplierValue").textContent = val;
            this.changed.tubeCpuMultiplier = val;
        });

        document.getElementById("hasTeletextAdaptor").addEventListener("click", () => {
            this.changed.hasTeletextAdaptor = document.getElementById("hasTeletextAdaptor").checked;
        });

        document.getElementById("hasEconet").addEventListener("click", () => {
            this.changed.hasEconet = document.getElementById("hasEconet").checked;
        });

        document.getElementById("hasMusic5000").addEventListener("click", () => {
            this.changed.hasMusic5000 = document.getElementById("hasMusic5000").checked;
        });

        for (const link of document.querySelectorAll(".keyboard-menu a")) {
            link.addEventListener("click", (e) => {
                const keyLayout = e.target.dataset.target;
                this.changed.keyLayout = keyLayout;
                this.setKeyLayout(keyLayout);
            });
        }

        for (const option of document.querySelectorAll(".mic-channel-option")) {
            option.addEventListener("click", (e) => {
                const channelString = e.target.dataset.channel;
                const channel = channelString === "" ? undefined : parseInt(channelString, 10);
                this.changed.microphoneChannel = channel;
                this.setMicrophoneChannel(channel);
            });
        }

        document.getElementById("mouseJoystickEnabled").addEventListener("click", () => {
            this.changed.mouseJoystickEnabled = document.getElementById("mouseJoystickEnabled").checked;
        });

        document.getElementById("speechOutput").addEventListener("click", () => {
            this.changed.speechOutput = document.getElementById("speechOutput").checked;
        });

        for (const option of document.querySelectorAll(".display-mode-option")) {
            option.addEventListener("click", (e) => {
                const mode = e.target.dataset.mode;
                this.changed.displayMode = mode;
                this.setDisplayMode(mode);
                this.onChange({ displayMode: mode });
            });
        }
    }

    setMicrophoneChannel(channel) {
        const text = channel !== undefined ? `Channel ${channel}` : "Disabled";
        for (const el of document.querySelectorAll(".mic-channel-text")) el.textContent = text;
    }

    setMouseJoystickEnabled(enabled) {
        document.getElementById("mouseJoystickEnabled").checked = !!enabled;
    }

    setSpeechOutput(enabled) {
        document.getElementById("speechOutput").checked = !!enabled;
    }

    setDisplayMode(mode) {
        const config = getFilterForMode(mode).getDisplayConfig();
        for (const el of document.querySelectorAll(".display-mode-text")) el.textContent = config.name;
    }

    setModel(modelName) {
        this.model = findModel(modelName);
        for (const el of document.querySelectorAll(".bbc-model")) el.textContent = this.model.name;
        
        // Show/hide Atom-specific UI elements
        for (const el of document.querySelectorAll(".atom-only")) {
            el.style.display = this.model.isAtom ? "block" : "none";
        }
    }

    setKeyLayout(keyLayout) {
        const text = keyLayout[0].toUpperCase() + keyLayout.substring(1);
        for (const el of document.querySelectorAll(".keyboard-layout")) el.textContent = text;
    }

    set65c02(enabled) {
        enabled = !!enabled;
        document.getElementById("65c02").checked = enabled;
        this.model.tube = enabled ? findModel("Tube65c02") : null;
        document.getElementById("tubeCpuMultiplier").disabled = !enabled;
    }

    setTubeCpuMultiplier(value) {
        this.tubeCpuMultiplier = value;
        document.getElementById("tubeCpuMultiplier").value = value;
        document.getElementById("tubeCpuMultiplierValue").textContent = value;
    }

    setEconet(enabled) {
        enabled = !!enabled;
        document.getElementById("hasEconet").checked = enabled;
        this.model.hasEconet = enabled;

        if (enabled && this.model.isMaster) {
            this.addRemoveROM("master/anfs-4.25.rom", true);
        }
    }

    setMusic5000(enabled) {
        enabled = !!enabled;
        document.getElementById("hasMusic5000").checked = enabled;
        this.model.hasMusic5000 = enabled;
        this.addRemoveROM("ample.rom", enabled);
    }

    setTeletext(enabled) {
        enabled = !!enabled;
        document.getElementById("hasTeletextAdaptor").checked = enabled;
        this.model.hasTeletextAdaptor = enabled;
        this.addRemoveROM("ats-3.0.rom", enabled);
    }

    setDropdownText(modelName) {
        const el = document.querySelector("#bbc-model-dropdown .bbc-model");
        if (el) el.textContent = modelName;
    }

    addRemoveROM(romName, required) {
        if (required && !this.model.os.includes(romName)) {
            this.model.os.push(romName);
        } else {
            let pos = this.model.os.indexOf(romName);
            if (pos !== -1) {
                this.model.os.splice(pos, 1);
            }
        }
    }

    mapLegacyModels(parsedQuery) {
        if (!parsedQuery.model) {
            return;
        }

        // "MasterTurbo" = Master + 6502 second processor
        if (parsedQuery.model.toLowerCase() === "masterturbo") {
            parsedQuery.model = "Master";
            parsedQuery.coProcessor = true;
        }

        // "BMusic5000" = BBC DFS 1.2 + Music 5000
        if (parsedQuery.model.toLowerCase() === "bmusic5000") {
            parsedQuery.model = "B-DFS1.2";
            parsedQuery.hasMusic5000 = true;
        }

        // "BTeletext" = BBC DFS 1.2 + Teletext adaptor
        if (parsedQuery.model.toLowerCase() === "bteletext") {
            parsedQuery.model = "B-DFS1.2";
            parsedQuery.hasTeletextAdaptor = true;
        }
    }
}

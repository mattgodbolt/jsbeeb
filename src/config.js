"use strict";
import $ from "jquery";
import { findModel } from "./models.js";
import { getFilterForMode } from "./canvas.js";

export class Config {
    constructor(onClose) {
        this.changed = {};
        this.model = null;
        this.coProcessor = null;
        const $configuration = document.getElementById("configuration");
        $configuration.addEventListener("show.bs.modal", () => {
            this.changed = {};
            this.setDropdownText(this.model.name);
            this.set65c02(this.model.tube);
            this.setTeletext(this.model.hasTeletextAdaptor);
            this.setMusic5000(this.model.hasMusic5000);
            this.setEconet(this.model.hasEconet);
        });

        $configuration.addEventListener("hide.bs.modal", () => onClose(this.changed));

        $(".model-menu a").on("click", (e) => {
            this.changed.model = $(e.target).attr("data-target");
            this.setDropdownText($(e.target).text());
        });

        $("#65c02").on("click", () => {
            this.changed.coProcessor = $("#65c02").prop("checked");
        });

        $("#hasTeletextAdaptor").on("click", () => {
            this.changed.hasTeletextAdaptor = $("#hasTeletextAdaptor").prop("checked");
        });

        $("#hasEconet").on("click", () => {
            this.changed.hasEconet = $("#hasEconet").prop("checked");
        });

        $("#hasMusic5000").on("click", () => {
            this.changed.hasMusic5000 = $("#hasMusic5000").prop("checked");
        });

        $(".keyboard-menu a").on("click", (e) => {
            const keyLayout = $(e.target).attr("data-target");
            this.changed.keyLayout = keyLayout;
            this.setKeyLayout(keyLayout);
        });

        $(".mic-channel-option").on("click", (e) => {
            const channelString = $(e.target).data("channel");
            const channel = channelString === "" ? undefined : parseInt($(e.target).data("channel"), 10);
            this.changed.microphoneChannel = channel;
            this.setMicrophoneChannel(channel);
        });

        $("#mouseJoystickEnabled").on("click", () => {
            this.changed.mouseJoystickEnabled = $("#mouseJoystickEnabled").prop("checked");
        });

        $(".display-mode-option").on("click", (e) => {
            const mode = $(e.target).data("mode");
            this.changed.displayMode = mode;
            this.setDisplayMode(mode);
        });
    }

    setMicrophoneChannel(channel) {
        if (channel !== undefined) {
            $(".mic-channel-text").text(`Channel ${channel}`);
        } else {
            $(".mic-channel-text").text("Disabled");
        }
    }

    setMouseJoystickEnabled(enabled) {
        $("#mouseJoystickEnabled").prop("checked", !!enabled);
    }

    setDisplayMode(mode) {
        const filter = getFilterForMode(mode);
        const config = filter.getDisplayConfig();
        $(".display-mode-text").text(config.name);

        const $monitorPic = $("#cub-monitor-pic");
        $monitorPic.attr("src", config.image);
        $monitorPic.attr("alt", config.imageAlt);
    }

    setModel(modelName) {
        this.model = findModel(modelName);
        $(".bbc-model").text(this.model.name);
    }

    setKeyLayout(keyLayout) {
        $(".keyboard-layout").text(keyLayout[0].toUpperCase() + keyLayout.substring(1));
    }

    set65c02(enabled) {
        enabled = !!enabled;
        $("#65c02").prop("checked", enabled);
        this.model.tube = enabled ? findModel("Tube65c02") : null;
    }

    setEconet(enabled) {
        enabled = !!enabled;
        $("#hasEconet").prop("checked", enabled);
        this.model.hasEconet = enabled;

        if (enabled && this.model.isMaster) {
            this.addRemoveROM("master/anfs-4.25.rom", true);
        }
    }

    setMusic5000(enabled) {
        enabled = !!enabled;
        $("#hasMusic5000").prop("checked", enabled);
        this.model.hasMusic5000 = enabled;
        this.addRemoveROM("ample.rom", enabled);
    }

    setTeletext(enabled) {
        enabled = !!enabled;
        $("#hasTeletextAdaptor").prop("checked", enabled);
        this.model.hasTeletextAdaptor = enabled;
        this.addRemoveROM("ats-3.0.rom", enabled);
    }

    setDropdownText(modelName) {
        $("#bbc-model-dropdown .bbc-model").text(modelName);
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

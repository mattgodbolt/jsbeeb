"use strict";
import $ from "jquery";
import { findModel } from "./models.js";

export function Config(onClose) {
    let changed = {};
    this.model = null;
    this.coProcessor = null;
    const $configuration = document.getElementById("configuration");
    $configuration.addEventListener("show.bs.modal", () => {
        changed = {};
        setDropdownText(this.model.name);
        this.set65c02(this.model.tube);
        this.setTeletext(this.model.hasTeletextAdaptor);
        this.setMusic5000(this.model.hasMusic5000);
    });

    $configuration.addEventListener("hide.bs.modal", () => onClose(changed));

    this.setModel = function (modelName) {
        this.model = findModel(modelName);
        $(".bbc-model").text(this.model.name);
    };

    this.setKeyLayout = function (keyLayout) {
        $(".keyboard-layout").text(keyLayout[0].toUpperCase() + keyLayout.substr(1));
    };

    this.set65c02 = function (enabled) {
        enabled = !!enabled;
        $("#65c02").prop("checked", enabled);
        this.model.tube = enabled ? findModel("Tube65c02") : null;
    };

    this.setMusic5000 = function (enabled) {
        enabled = !!enabled;
        $("#hasMusic5000").prop("checked", enabled);
        this.model.hasMusic5000 = enabled;
        this.addRemoveROM("ample.rom", enabled);
    };

    this.setTeletext = function (enabled) {
        enabled = !!enabled;
        $("#hasTeletextAdaptor").prop("checked", enabled);
        this.model.hasTeletextAdaptor = enabled;
        this.addRemoveROM("ats-3.0.rom", enabled);
    };

    function setDropdownText(modelName) {
        $("#bbc-model-dropdown .bbc-model").text(modelName);
    }

    $(".model-menu a").on(
        "click",
        function (e) {
            const modelName = $(e.target).attr("data-target");
            changed.model = modelName;

            setDropdownText($(e.target).text());
        }.bind(this)
    );

    $("#65c02").on(
        "click",
        function () {
            changed.coProcessor = $("#65c02").prop("checked");
        }.bind(this)
    );

    $("#hasTeletextAdaptor").on(
        "click",
        function () {
            changed.hasTeletextAdaptor = $("#hasTeletextAdaptor").prop("checked");
        }.bind(this)
    );

    $("#hasMusic5000").on(
        "click",
        function () {
            changed.hasMusic5000 = $("#hasMusic5000").prop("checked");
        }.bind(this)
    );

    $(".keyboard-menu a").on(
        "click",
        function (e) {
            const keyLayout = $(e.target).attr("data-target");
            changed.keyLayout = keyLayout;
            this.setKeyLayout(keyLayout);
        }.bind(this)
    );

    this.addRemoveROM = function (romName, required) {
        if (required && !this.model.os.includes(romName)) {
            this.model.os.push(romName);
        } else {
            let pos = this.model.os.indexOf(romName);
            if (pos != -1) {
                this.model.os.splice(pos, 1);
            }
        }
    };

    this.mapLegacyModels = function (parsedQuery) {
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
    };
}

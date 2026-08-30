import { toast } from "./toast.js";

class Light {
    constructor(name) {
        this.dom = document.getElementById(name);
        this.on = false;
    }

    update(val) {
        if (val === this.on) return;
        this.on = val;
        this.dom.classList.toggle("on", this.on);
    }
}

/**
 * The furniture around the screen: the keyboard and drive lights, the tape
 * controls, and the pop-up window the printer prints into.
 */
export class FrontPanel {
    constructor({ processor, model, printer }) {
        this.processor = processor;
        this.model = model;
        this.printer = printer;
        this.printerWindow = null;
        this.printerTextArea = null;

        for (const link of document.querySelectorAll("#tape-menu a")) {
            link.addEventListener("click", (e) => {
                const type = e.target.dataset.id;
                if (type === undefined) return;

                if (type === "rewind") {
                    console.log("Rewinding tape to the start");
                    if (model.isAtom) {
                        processor.atomppia.stopTape();
                        processor.atomppia.rewindTape();
                        this.updateTapeButton();
                    } else {
                        processor.acia.rewindTape();
                    }
                } else {
                    console.log("unknown type", type);
                }
            });
        }

        this.tapePlayStopBtn = document.getElementById("tape-play-stop");
        this.tapeControlHeader = document.getElementById("tape-control-header");
        this.tapeControlCell = document.getElementById("tape-control-cell");

        this.tapePlayStopBtn.addEventListener("click", () => {
            if (processor.atomppia.motorOn) {
                processor.atomppia.stopTape();
            } else {
                processor.atomppia.playTape();
            }
            this.updateTapeButton();
        });

        this.cassette = new Light("motorlight");
        this.caps = new Light("capslight");
        this.shift = new Light("shiftlight");
        this.drive0 = new Light("drive0");
        this.drive1 = new Light("drive1");
        this.network = new Light("networklight");

        this.updateLedVisibility();
    }

    updateTapeButton() {
        if (!this.model.isAtom) return;
        const playing = this.processor.atomppia.motorOn;
        const label = playing ? "Stop cassette" : "Play cassette";
        this.tapePlayStopBtn.textContent = playing ? "■" : "▶";
        this.tapePlayStopBtn.title = label;
        this.tapePlayStopBtn.setAttribute("aria-label", label);
        this.tapePlayStopBtn.classList.toggle("playing", playing);
    }

    showTapeControl(visible) {
        const display = visible ? "" : "none";
        this.tapeControlHeader.style.display = display;
        this.tapeControlCell.style.display = display;
    }

    updateLedVisibility() {
        const bbcDisplay = this.model.isAtom ? "none" : "";
        for (const el of document.querySelectorAll(".bbc-only")) {
            el.style.display = bbcDisplay;
        }
        this.showTapeControl(this.model.isAtom);
    }

    syncLights() {
        const { processor } = this;
        if (this.model.isAtom) {
            this.cassette.update(processor.atomppia.motorOn);
        } else {
            this.caps.update(processor.sysvia.capsLockLight);
            this.shift.update(processor.sysvia.shiftLockLight);
            this.drive0.update(processor.fdc.motorOn[0]);
            this.drive1.update(processor.fdc.motorOn[1]);
            this.cassette.update(processor.acia.motorOn);
            if (processor.econet) {
                this.network.update(processor.econet.activityLight());
            }
        }
    }

    /** What the printer prints lands in its window, when one is open. */
    printChar(char) {
        if (this.printerTextArea) this.printerTextArea.value += char;
    }

    checkPrinterWindow() {
        if (this.printerWindow && !this.printerWindow.closed) return;

        this.printerWindow = window.open("", "_blank", "height=300,width=400");
        if (!this.printerWindow) {
            toast(
                "The printer output window was blocked. Allow pop-up windows for this site, then press Ctrl-B again.",
                {
                    title: "Printer",
                },
            );
            return;
        }
        this.printerWindow.document.write(
            '<textarea id="text" rows="15" cols="40" placeholder="Printer outputs here..."></textarea>',
        );
        this.printerTextArea = this.printerWindow.document.getElementById("text");
        this.printerTextArea.value = this.printer.text;
    }
}

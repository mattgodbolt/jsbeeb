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
 * The furniture around the screen: the keyboard, drive and cassette lights,
 * and the pop-up window the printer prints into.
 */
export class FrontPanel {
    constructor({ processor, model, printer, loop }) {
        this.processor = processor;
        this.model = model;
        this.printer = printer;
        this.printerWindow = null;
        this.printerTextArea = null;
        loop.addEventListener("tick", () => this.syncLights());
        printer.addEventListener("output", (event) => this.printChar(event.detail));
        printer.addEventListener("first-output", () =>
            toast("Printer output is being kept. Press Ctrl-B to open the printer window.", {
                title: "Printer",
                quietKey: "quietPrinterOutput",
            }),
        );

        this.cassette = new Light("motorlight");
        this.caps = new Light("capslight");
        this.shift = new Light("shiftlight");
        this.drive0 = new Light("drive0");
        this.drive1 = new Light("drive1");
        this.network = new Light("networklight");

        this.updateLedVisibility();
    }

    updateLedVisibility() {
        const bbcDisplay = this.model.isAtom ? "none" : "";
        for (const el of document.querySelectorAll(".bbc-only")) {
            el.style.display = bbcDisplay;
        }
    }

    syncLights() {
        const { processor } = this;
        this.cassette.update(processor.tapeInterface.motorOn);
        if (!this.model.isAtom) {
            this.caps.update(processor.sysvia.capsLockLight);
            this.shift.update(processor.sysvia.shiftLockLight);
            this.drive0.update(processor.fdc.motorOn[0]);
            this.drive1.update(processor.fdc.motorOn[1]);
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

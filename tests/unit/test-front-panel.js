// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FrontPanel } from "../../src/web/front-panel.js";
import { Printer } from "../../src/printer.js";
import { domFromIndexHtml, teardownDom, toasts } from "./helpers.js";

describe("FrontPanel", () => {
    let processor;
    let loop;

    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        domFromIndexHtml("tape-menu", "leds");
        processor = {
            sysvia: { capsLockLight: false, shiftLockLight: false },
            fdc: { motorOn: [false, false] },
            acia: { motorOn: false, rewindTape: vi.fn() },
            atomppia: { motorOn: false, playTape: vi.fn(), stopTape: vi.fn(), rewindTape: vi.fn() },
            econet: null,
        };
        loop = new EventTarget();
    });

    afterEach(teardownDom);

    const make = (isAtom = false, printer = new Printer()) =>
        new FrontPanel({ processor, model: { isAtom }, printer, loop });
    const lit = (id) => document.getElementById(id).classList.contains("on");

    describe("the lights", () => {
        it("follow the machine", () => {
            const panel = make();
            processor.sysvia.capsLockLight = true;
            processor.fdc.motorOn[1] = true;
            panel.syncLights();
            expect(lit("capslight")).toBe(true);
            expect(lit("drive1")).toBe(true);
            expect(lit("shiftlight")).toBe(false);
        });

        it("only touch the DOM when something changed", () => {
            const panel = make();
            processor.sysvia.capsLockLight = true;
            panel.syncLights();
            const toggled = vi.spyOn(document.getElementById("capslight").classList, "toggle");
            panel.syncLights();
            expect(toggled).not.toHaveBeenCalled();
        });

        it("show only the cassette motor on an Atom", () => {
            const panel = make(true);
            processor.atomppia.motorOn = true;
            panel.syncLights();
            expect(lit("motorlight")).toBe(true);
        });
    });

    describe("what each machine shows", () => {
        it("hides the BBC lights and shows the tape control on an Atom", () => {
            make(true);
            expect(document.getElementById("capslight").closest(".bbc-only").style.display).toBe("none");
            expect(document.getElementById("tape-control-header").style.display).toBe("");
        });

        it("shows the BBC lights and hides the tape control on a BBC", () => {
            make(false);
            expect(document.getElementById("capslight").closest(".bbc-only").style.display).toBe("");
            expect(document.getElementById("tape-control-header").style.display).toBe("none");
        });
    });

    describe("the tape controls", () => {
        it("plays and stops the Atom's cassette, showing which is next", () => {
            make(true);
            const button = document.getElementById("tape-play-stop");
            button.click();
            expect(processor.atomppia.playTape).toHaveBeenCalled();
            processor.atomppia.motorOn = true;
            button.click();
            expect(processor.atomppia.stopTape).toHaveBeenCalled();
            expect(button.textContent).toBe("■");
        });

        it("rewinds through the right interface for the machine", () => {
            make(false);
            document.querySelector('#tape-menu a[data-id="rewind"]').click();
            expect(processor.acia.rewindTape).toHaveBeenCalled();
            expect(processor.atomppia.rewindTape).not.toHaveBeenCalled();
        });

        it("stops the Atom's tape before rewinding it", () => {
            make(true);
            document.querySelector('#tape-menu a[data-id="rewind"]').click();
            expect(processor.atomppia.stopTape).toHaveBeenCalled();
            expect(processor.atomppia.rewindTape).toHaveBeenCalled();
        });

        it("ignores menu links it does not handle", () => {
            const link = document.getElementById("tape-menu").appendChild(document.createElement("a"));
            link.dataset.id = "archive";
            make(false);
            link.click();
            expect(processor.acia.rewindTape).not.toHaveBeenCalled();
            expect(console.log).not.toHaveBeenCalled();
        });
    });

    describe("the printer window", () => {
        it("says how to open it the first time anything prints", () => {
            const printer = new Printer();
            make(false, printer);
            printer.dispatchEvent(new Event("first-output"));
            expect(toasts()).toEqual([expect.stringContaining("Ctrl-B")]);
        });

        it("says when the pop-up was blocked", () => {
            vi.spyOn(window, "open").mockReturnValue(null);
            make().checkPrinterWindow();
            expect(toasts()).toEqual([expect.stringContaining("blocked")]);
        });

        it("quietly keeps output until a window is open", () => {
            const panel = make();
            expect(() => panel.printChar("A")).not.toThrow();
        });

        it("seeds a new window with what has printed so far", () => {
            const fakeArea = { value: "" };
            const fakeWindow = {
                closed: false,
                document: { write: vi.fn(), getElementById: () => fakeArea },
            };
            vi.spyOn(window, "open").mockReturnValue(fakeWindow);
            const printer = Object.assign(new EventTarget(), { text: "so far" });
            const panel = make(false, printer);
            panel.checkPrinterWindow();
            expect(fakeArea.value).toBe("so far");
            printer.dispatchEvent(new CustomEvent("output", { detail: "!" }));
            expect(fakeArea.value).toBe("so far!");
            // A second check leaves the open window alone.
            panel.checkPrinterWindow();
            expect(window.open).toHaveBeenCalledTimes(1);
        });
    });
});

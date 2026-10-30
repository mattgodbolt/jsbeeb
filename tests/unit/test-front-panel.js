// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FrontPanel } from "../../src/web/front-panel.js";
import { Printer } from "../../src/printer.js";
import { domFromIndexHtml, sentEvents, teardownDom, toasts } from "./helpers.js";

describe("FrontPanel", () => {
    let processor;
    let loop;

    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        domFromIndexHtml("leds");
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

    const Bbc = { isAtom: false, hasDiscDrives: true };
    const Atom = { isAtom: true, hasDiscDrives: false };
    const AtomDos = { isAtom: true, hasDiscDrives: true };
    const make = (model = Bbc, printer = new Printer()) => {
        processor.tapeInterface = model.isAtom ? processor.atomppia : processor.acia;
        return new FrontPanel({ processor, model, printer, loop });
    };
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
            const panel = make(Atom);
            processor.atomppia.motorOn = true;
            panel.syncLights();
            expect(lit("motorlight")).toBe(true);
        });
    });

    describe("what each machine shows", () => {
        const shown = (id) => document.getElementById(id).closest(".slot-readout, .cell").style.display !== "none";

        it.each([
            ["a BBC", Bbc, true, true],
            ["an Atom", Atom, false, false],
            ["an Atom with DOS", AtomDos, false, true],
        ])(
            "shows %s the keyboard lights if it is a BBC, and drive lights that work if it has drives",
            (_, model, keyboard, drives) => {
                const panel = make(model);
                processor.fdc.motorOn[0] = true;
                panel.syncLights();
                expect([shown("capslight"), shown("drive0"), shown("drive1"), lit("drive0")]).toEqual([
                    keyboard,
                    drives,
                    drives,
                    drives,
                ]);
                expect([shown("motorlight"), shown("speed-turbo")]).toEqual([true, true]);
            },
        );
    });

    describe("the printer window", () => {
        it("says how to open it the first time anything prints", () => {
            const printer = new Printer();
            make(Bbc, printer);
            printer.dispatchEvent(new Event("first-output"));
            expect(toasts()).toEqual([expect.stringContaining("Press Alt-B to open")]);
        });

        it("names the shortcut as a Mac's keyboard prints it, on a Mac", async () => {
            vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
            vi.spyOn(window, "open").mockReturnValue(null);
            vi.resetModules();
            const { FrontPanel: MacFrontPanel } = await import("../../src/web/front-panel.js");
            const printer = new Printer();
            const panel = new MacFrontPanel({ processor, model: { isAtom: false }, printer, loop });
            printer.dispatchEvent(new Event("first-output"));
            panel.checkPrinterWindow();
            expect(toasts()).toEqual([
                expect.stringContaining("Press ⌥B to open"),
                expect.stringContaining("then press ⌥B again."),
            ]);
        });

        it("says when the pop-up was blocked", () => {
            vi.spyOn(window, "open").mockReturnValue(null);
            make().checkPrinterWindow();
            expect(toasts()).toEqual([
                expect.stringContaining("blocked. Allow pop-up windows for this site, then press Alt-B again."),
            ]);
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
            const panel = make(Bbc, printer);
            panel.checkPrinterWindow();
            expect(fakeArea.value).toBe("so far");
            printer.dispatchEvent(new CustomEvent("output", { detail: "!" }));
            expect(fakeArea.value).toBe("so far!");
            // A second check leaves the open window alone.
            panel.checkPrinterWindow();
            expect(window.open).toHaveBeenCalledTimes(1);
        });

        it("notes the printer opening only when a window opens", () => {
            const sent = sentEvents();
            vi.spyOn(window, "open").mockReturnValueOnce(null);
            const panel = make(Bbc, Object.assign(new EventTarget(), { text: "" }));
            panel.checkPrinterWindow();
            window.open.mockReturnValueOnce({
                closed: false,
                document: { write: vi.fn(), getElementById: () => ({ value: "" }) },
            });
            panel.checkPrinterWindow();
            expect(sent("feature_used")).toEqual([{ feature: "printer", action: "open" }]);
        });
    });
});

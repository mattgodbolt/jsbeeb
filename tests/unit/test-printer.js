import { describe, it, expect, beforeEach } from "vitest";
import { Printer, MaxBufferedChars } from "../../src/printer.js";
import { UserVia } from "../../src/via.js";
import { Scheduler } from "../../src/scheduler.js";

const OraNoHandshake = 0x0f;
const Pcr = 0x0c;
const Ifr = 0x0d;
const PcrCa2High = 0x0e;
const PcrCa2Low = 0x0c;
const IntCa1 = 0x02;

function makeUserVia() {
    return new UserVia({ interrupt: 0 }, new Scheduler(), false, { read: () => 0xff, write: () => {} });
}

function print(uservia, text) {
    for (const char of text) {
        uservia.write(OraNoHandshake, char.charCodeAt(0));
        uservia.write(Pcr, PcrCa2High);
        uservia.write(Pcr, PcrCa2Low);
    }
}

describe("Printer", () => {
    let uservia;

    beforeEach(() => {
        uservia = makeUserVia();
    });

    function attach(printer) {
        uservia.ca2changecallback = (level, output) => printer.outputStrobe(level, output);
        printer.attach(uservia);
        return printer;
    }

    describe("acknowledging characters", () => {
        it("acks each character with no printer window open", () => {
            attach(new Printer());

            print(uservia, "A");

            expect(uservia.read(Ifr) & IntCa1).toBe(IntCa1);
        });

        it("acks every character of a run", () => {
            attach(new Printer());

            for (const char of "HELLO") {
                print(uservia, char);
                expect(uservia.read(Ifr) & IntCa1).toBe(IntCa1);
                uservia.write(Ifr, 0x7f);
            }
        });
    });

    describe("buffering", () => {
        it("keeps output printed with no window open", () => {
            const printer = attach(new Printer());

            print(uservia, "HELLO");

            expect(printer.text).toBe("HELLO");
        });

        it("keeps the most recent output when the bound is passed", () => {
            const printer = attach(new Printer());

            const printed = "0123456789".repeat(Math.ceil(MaxBufferedChars / 10) + 1);
            print(uservia, printed);

            expect(printer.text.length).toBe(MaxBufferedChars);
            expect(printer.text).toBe(printed.slice(-MaxBufferedChars));
        });
    });

    describe("live output", () => {
        it("reports each character as it is printed", () => {
            const seen = [];
            attach(new Printer({ onOutput: (char) => seen.push(char) }));

            print(uservia, "HI");

            expect(seen).toEqual(["H", "I"]);
        });

        it("offers the buffered text to a window opened part way through", () => {
            let windowText = "";
            const printer = attach(
                new Printer({
                    onOutput: (char) => {
                        windowText += char;
                    },
                }),
            );

            print(uservia, "BEFORE ");
            windowText = printer.text;
            print(uservia, "AFTER");

            expect(windowText).toBe("BEFORE AFTER");
        });
    });

    describe("first output notice", () => {
        it("reports only the first character printed", () => {
            let notices = 0;
            attach(new Printer({ onFirstOutput: () => notices++ }));

            print(uservia, "HELLO");

            expect(notices).toBe(1);
        });

        it("says nothing until something is printed", () => {
            let notices = 0;
            attach(new Printer({ onFirstOutput: () => notices++ }));

            expect(notices).toBe(0);
        });
    });
});

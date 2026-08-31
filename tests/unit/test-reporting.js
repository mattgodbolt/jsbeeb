// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
    errorText,
    reportIgnoredFiles,
    reportLoadFailure,
    showNotice,
    unzipAndReport,
} from "../../src/web/reporting.js";
import { teardownDom, toasts } from "./helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readZip = (name) => new Uint8Array(fs.readFileSync(join(__dirname, "zip", name)));

describe("reporting", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(teardownDom);

    describe("errorText", () => {
        it("uses an error's message", () => {
            expect(errorText(new Error("Bad disc"))).toBe("Bad disc");
        });

        it("stringifies anything else that was thrown", () => {
            expect(errorText("plain string")).toBe("plain string");
            expect(errorText(42)).toBe("42");
            expect(errorText(undefined)).toBe("undefined");
        });
    });

    describe("reportLoadFailure", () => {
        it("toasts what could not be loaded and why", () => {
            reportLoadFailure("disc elite.ssd", new Error("404"));
            expect(toasts()).toEqual([expect.stringContaining("Could not load disc elite.ssd: 404")]);
        });

        it("keeps the full error on the console", () => {
            const error = new Error("404");
            reportLoadFailure("disc elite.ssd", error);
            expect(console.error).toHaveBeenCalledWith("Error loading disc elite.ssd:", error);
        });
    });

    describe("reportIgnoredFiles", () => {
        it("says nothing when the archive held only the one file", () => {
            reportIgnoredFiles("game.ssd", []);
            expect(toasts()).toEqual([]);
        });

        it("names the files that were passed over", () => {
            reportIgnoredFiles("side1.ssd", ["side2.ssd", "notes.txt"]);
            expect(toasts()).toEqual([
                expect.stringContaining("Loaded side1.ssd. The archive also holds side2.ssd, notes.txt"),
            ]);
        });
    });

    describe("unzipAndReport", () => {
        it("returns the unzipped image and reports the members it passed over", async () => {
            const unzipped = await unzipAndReport(readZip("test-two-sides.zip"));
            expect(unzipped.name).toBe("side1.ssd");
            expect(unzipped.ignored).toEqual(["side2.ssd"]);
            expect(toasts()).toEqual([expect.stringContaining("side2.ssd")]);
        });

        it("is quiet about an archive with nothing else loadable in it", async () => {
            const unzipped = await unzipAndReport(readZip("test-mixed.zip"));
            expect(unzipped.name).toBe("test.ssd");
            expect(toasts()).toEqual([]);
        });
    });

    describe("showNotice", () => {
        it("toasts a component's notice event", () => {
            showNotice(new CustomEvent("notice", { detail: { message: "Tape motor on", title: "Tape" } }));
            expect(toasts()).toEqual([expect.stringContaining("Tape motor on")]);
        });
    });
});

import { describe, it, expect } from "vitest";

import { getArguments } from "../../src/app/args.js";

// Regression tests for issue #684: on Windows the packaged binary is jsbeeb.exe,
// so basename(argv[0]) === "jsbeeb" was always false and the first user argument
// (e.g. --noboot) was silently dropped via slice(2). Now we key off Electron's
// process.defaultApp so the dev/packaged distinction is reliable on every OS.
describe("getArguments", () => {
    it("strips only the binary path for a packaged Electron app on Linux", () => {
        const argv = ["/opt/jsbeeb/jsbeeb", "--noboot", "foo.dsd"];
        expect(getArguments(argv, undefined)).toEqual(["--noboot", "foo.dsd"]);
    });

    it("strips only the binary path for a packaged Electron app on Windows (issue #684)", () => {
        const argv = ["C:\\Program Files\\jsbeeb\\jsbeeb.exe", "--noboot", "foo.dsd"];
        expect(getArguments(argv, undefined)).toEqual(["--noboot", "foo.dsd"]);
    });

    it("strips only the binary path for a packaged Electron app on macOS", () => {
        const argv = ["/Applications/jsbeeb.app/Contents/MacOS/jsbeeb", "--noboot", "foo.dsd"];
        expect(getArguments(argv, undefined)).toEqual(["--noboot", "foo.dsd"]);
    });

    it("skips electron binary and app path in development mode", () => {
        const argv = ["/usr/bin/electron", "/home/user/jsbeeb", "--noboot", "foo.dsd"];
        expect(getArguments(argv, true)).toEqual(["--noboot", "foo.dsd"]);
    });

    it("preserves a bare disc image when running as a packaged app", () => {
        const argv = ["C:\\Program Files\\jsbeeb\\jsbeeb.exe", "foo.dsd"];
        expect(getArguments(argv, undefined)).toEqual(["foo.dsd"]);
    });

    it("filters out Chrome flags injected by the runtime", () => {
        const argv = ["/opt/jsbeeb/jsbeeb", "--no-sandbox", "--disable-gpu", "--noboot", "foo.dsd"];
        expect(getArguments(argv, undefined)).toEqual(["--noboot", "foo.dsd"]);
    });
});

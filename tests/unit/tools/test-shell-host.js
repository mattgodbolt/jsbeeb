import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { atob, CustomEvent, EventTarget, path, url, Utf8Decoder } from "../../../tools/shell-host.js";

describe("the shells' stand-ins", () => {
    it.each(["", "QQ==", "QUI=", "QUJD", btoa("\x00\xff\x80 jsbeeb \x7f".repeat(9))])(
        "decodes base64 %j as the browser's atob does",
        (base64) => {
            expect(atob(base64)).toBe(globalThis.atob(base64));
        },
    );

    it("decodes UTF-8 as TextDecoder does", () => {
        const bytes = new TextEncoder().encode('{"name": "Acorn £ é \u{1f600}"}');
        expect(new Utf8Decoder().decode(bytes)).toBe(new TextDecoder().decode(bytes));
    });

    it("joins, resolves and takes the directory of absolute paths as Node's path does", () => {
        expect(path.join("/a/b", "public", "../x/./y.js")).toBe(nodePath.join("/a/b", "public", "../x/./y.js"));
        expect(path.resolve("/a/b/src", "..")).toBe(nodePath.resolve("/a/b/src", ".."));
        expect(path.dirname("/a/b/c.js")).toBe(nodePath.dirname("/a/b/c.js"));
    });

    it("turns a file URL back into its path", () => {
        const file = "/tmp/a dir/b.js";
        expect(url.fileURLToPath(pathToFileURL(file).href)).toBe(file);
    });

    it("dispatches an event to each listener until it is removed", () => {
        const target = new EventTarget();
        const listener = vi.fn();
        target.addEventListener("notice", listener);
        target.dispatchEvent(new CustomEvent("notice", { detail: 1 }));
        target.removeEventListener("notice", listener);
        target.dispatchEvent(new CustomEvent("notice", { detail: 2 }));
        expect(listener.mock.calls.map(([event]) => event.detail)).toEqual([1]);
    });
});

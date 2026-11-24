import { describe, expect, it, vi } from "vitest";

import { allowMidiPermissions } from "../../src/app/midi-permissions.js";

describe("Electron MIDI permissions", () => {
    it("grants MIDI access only to the jsbeeb app page", () => {
        const session = {
            setPermissionCheckHandler: vi.fn(),
            setPermissionRequestHandler: vi.fn(),
        };
        const appContents = { getURL: () => "file:///opt/jsbeeb/dist/index.html?model=Master" };
        const otherContents = { getURL: () => appContents.getURL() };
        allowMidiPermissions(session, appContents, "/opt/jsbeeb/dist/index.html");

        const check = session.setPermissionCheckHandler.mock.calls[0][0];
        const request = session.setPermissionRequestHandler.mock.calls[0][0];
        expect(check(appContents, "midi")).toBe(true);
        expect(check(appContents, "midiSysex")).toBe(true);
        expect(check(appContents, "geolocation")).toBe(false);
        expect(check(otherContents, "midi")).toBe(false);
        expect(check({ getURL: () => "file:///tmp/other.html" }, "midi")).toBe(false);

        const callback = vi.fn();
        request(appContents, "midiSysex", callback);
        expect(callback).toHaveBeenCalledWith(true);
        request(otherContents, "midiSysex", callback);
        expect(callback).toHaveBeenLastCalledWith(false);
    });
});

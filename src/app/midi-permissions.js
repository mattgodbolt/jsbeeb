import * as path from "node:path";
import { fileURLToPath } from "node:url";

const MidiPermissions = new Set(["midi", "midiSysex"]);

export function allowMidiPermissions(session, appContents, appHtmlPath) {
    const isAllowed = (contents, permission) => {
        if (contents !== appContents || !MidiPermissions.has(permission)) return false;
        try {
            return path.resolve(fileURLToPath(contents.getURL())) === appHtmlPath;
        } catch {
            return false;
        }
    };

    session.setPermissionCheckHandler((contents, permission) => isAllowed(contents, permission));
    session.setPermissionRequestHandler((contents, permission, callback) => {
        callback(isAllowed(contents, permission));
    });
}

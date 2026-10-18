import { readFileSync } from "node:fs";
import browserslist from "browserslist";

const BrowserNames = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari", ios_saf: "Safari" };
const Contact = "matt@godbolt.org";
const FloorScript = readFileSync(new URL("../src/web/browser-floor.js", import.meta.url), "utf8");
// Inline, as jsbeeb.css may never arrive, and visible inside the body jsbeeb.css has not yet revealed.
const MessageStyle = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "right: 0",
    "z-index: 10000",
    "visibility: visible",
    "padding: 0.75em 3em 0.75em 1em",
    "background: #fff3cd",
    "color: #332701",
    "font: 16px/1.4 system-ui, sans-serif",
].join("; ");
const CloseStyle =
    "position: absolute; top: 0.5em; right: 0.75em; font-size: 1.25em; background: none; border: none; color: inherit; cursor: pointer";
const MessageHtml = `<span id="browser-floor-text"></span>
If you can't update, or this seems wrong, please get in touch:
<a href="mailto:${Contact}" style="color: inherit">${Contact}</a>.
<button type="button" aria-label="Close" onclick="this.parentNode.hidden = true" style="${CloseStyle}">&times;</button>`;

const compareVersions = (a, b) => {
    const [aParts, bParts] = [a, b].map((version) => version.split(".").map(Number));
    for (let i = 0; i < Math.max(aParts.length, bParts.length); ++i) {
        const difference = (aParts[i] ?? 0) - (bParts[i] ?? 0);
        if (difference) return difference;
    }
    return 0;
};

const listWithOr = (items) =>
    items.length > 2 ? `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}` : items.join(" or ");

/** The oldest version of each browser `queries` (package.json's browserslist by default) allows, by display name. */
export function browserFloors(queries = undefined) {
    const floors = {};
    for (const entry of browserslist(queries)) {
        const [family, versions] = entry.split(" ");
        const name = BrowserNames[family];
        if (!name) throw new Error(`No display name for browserslist's "${family}"`);
        // ios_saf gives some versions as ranges, such as "16.6-16.7".
        const version = versions.split("-")[0];
        if (floors[name] === undefined || compareVersions(version, floors[name]) < 0) floors[name] = version;
    }
    return floors;
}

/** `floors` as a phrase such as "Chrome or Edge 111, Firefox 115, or Safari 16.4", saying a shared version once. */
export function floorText(floors = browserFloors()) {
    const namesByVersion = new Map();
    for (const [name, version] of Object.entries(floors)) {
        namesByVersion.set(version, [...(namesByVersion.get(version) ?? []), name]);
    }
    return listWithOr([...namesByVersion].map(([version, names]) => `${names.join(" or ")} ${version}`));
}

/**
 * The message a browser below package.json's browserslist sees, and the classic script that shows it when the
 * browser's agent string is below the floor or the module bundle dies before main.js calls `jsbeebStartupFinished`.
 */
export function browserFloorPlugin(measurementId = process.env.GA_MEASUREMENT_ID) {
    const floors = browserFloors();
    const config = JSON.stringify({ floors, supported: floorText(floors), measurementId: measurementId || "" });
    const script = `${FloorScript}browserFloor(${config.replaceAll("<", "\\u003c")});\n`;
    const message = {
        tag: "div",
        attrs: { id: "browser-floor", role: "alert", hidden: true, style: MessageStyle },
        children: MessageHtml,
        injectTo: "body-prepend",
    };
    return {
        name: "browser-floor",
        transformIndexHtml: () => [{ tag: "script", children: script, injectTo: "head" }, message],
    };
}

import arrowCounterclockwise from "bootstrap-icons/icons/arrow-counterclockwise.svg?raw";
import cassette from "bootstrap-icons/icons/cassette.svg?raw";
import clockHistory from "bootstrap-icons/icons/clock-history.svg?raw";
import display from "bootstrap-icons/icons/display.svg?raw";
import floppy from "bootstrap-icons/icons/floppy.svg?raw";
import gear from "bootstrap-icons/icons/gear.svg?raw";
import headphones from "bootstrap-icons/icons/headphones.svg?raw";
import pauseFill from "bootstrap-icons/icons/pause-fill.svg?raw";
import playFill from "bootstrap-icons/icons/play-fill.svg?raw";
import soundwave from "bootstrap-icons/icons/soundwave.svg?raw";
import stars from "bootstrap-icons/icons/stars.svg?raw";
import threeDots from "bootstrap-icons/icons/three-dots.svg?raw";
import tv from "bootstrap-icons/icons/tv.svg?raw";
import volumeUp from "bootstrap-icons/icons/volume-up.svg?raw";

/** The Bootstrap Icons the page uses, by their upstream names; nothing else of the set is bundled. */
const Icons = {
    "arrow-counterclockwise": arrowCounterclockwise,
    cassette,
    "clock-history": clockHistory,
    display,
    floppy,
    gear,
    headphones,
    "pause-fill": pauseFill,
    "play-fill": playFill,
    soundwave,
    stars,
    "three-dots": threeDots,
    tv,
    "volume-up": volumeUp,
};

export const IconNames = Object.freeze(Object.keys(Icons));

/** Puts the named SVG inside every `[data-icon]` element under `root`; an unknown name leaves them all untouched. */
export function installIcons(root = document) {
    const placeholders = [...root.querySelectorAll("[data-icon]")];
    const unknown = placeholders.find((el) => !(el.dataset.icon in Icons));
    if (unknown) throw new Error(`No icon named ${unknown.dataset.icon}`);
    for (const el of placeholders) el.innerHTML = Icons[el.dataset.icon];
}

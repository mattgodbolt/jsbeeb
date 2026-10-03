// The session's readout in the lights along the bottom of the page, a light for each peer so how
// everyone is doing can be seen at a glance, and the pane it opens: the link to join, each peer's
// numbers as they come, and the session's report to save.

import { FloatingPanel } from "./floating-panel.js";

// A guest catches up by a large slice per execute (see MaxCatchUpSeconds), so one still this far behind after an
// execute has fallen a long way behind, not just had a burst of commits.
export const LaggingMs = 100;
// Stats arrive once a second, so a peer silent this long has stalled, or its connection has.
export const SilentMs = 3000;
// A guest that runs out of the host's commits now and then is barely seen; more often, it stutters.
const MaxStarvedPerSecond = 2;
const PaneGapPx = 6;

const Descriptions = { connecting: "connecting", ok: "keeping up", lagging: "lagging", silent: "out of touch" };
export const PeerStates = new Set([...Object.keys(Descriptions), "left"]);

/**
 * How a peer is doing, from what it last reported (`stats`, `statsAgeMs` after it came), until which
 * it is still joining: "connecting", "ok", "lagging" (a long way behind, or stuttering to keep up),
 * "silent" (nothing heard, or no commits getting through) or "left".
 */
export function peerState({ connected, left, stats, statsAgeMs }) {
    if (left) return "left";
    if (!connected || !stats) return "connecting";
    if (statsAgeMs >= SilentMs || stats.commits === 0) return "silent";
    if (stats.lagMs > LaggingMs || stats.starved > MaxStarvedPerSecond) return "lagging";
    return "ok";
}

/** A line about a peer, from its `state` and whichever of `rttMs`, `lagMs` and `leftReason` are known. */
export function peerDetail({ state, rttMs, lagMs, leftReason }) {
    if (state === "left") return `left: ${leftReason}`;
    const parts = [Descriptions[state]];
    if (rttMs !== undefined) parts.push(`${Math.round(rttMs)} ms round trip`);
    if (lagMs !== undefined) parts.push(`${lagMs} ms behind`);
    return parts.join(", ");
}

function cell(text, className = "") {
    const td = document.createElement("td");
    td.className = className;
    td.textContent = text;
    return td;
}

function light(peer) {
    const led = document.createElement("span");
    led.className = "led session";
    led.classList.toggle("on", peer.state !== "connecting");
    led.dataset.state = peer.state;
    led.title = `${peer.label}: ${peerDetail(peer)}`;
    return led;
}

function peerRow(peer) {
    const row = document.createElement("tr");
    const lightCell = cell("");
    lightCell.append(light(peer));
    const left = peer.state === "left";
    row.append(
        lightCell,
        cell(peer.control ? `${peer.label} (in control)` : peer.label),
        cell(left ? `left: ${peer.leftReason}` : Descriptions[peer.state]),
        cell(!left && peer.rttMs !== undefined ? `${Math.round(peer.rttMs)} ms` : "", "number"),
        cell(!left && peer.lagMs !== undefined ? `${peer.lagMs} ms` : "", "number"),
    );
    return row;
}

export class SessionPanel {
    /**
     * @param {object} session
     * @param {string} session.name what this person goes by
     * @param {string} session.link the address a guest joins at
     * @param {function(): void} session.saveReport
     * @param {function(): void} session.copyLink
     * @param {function(): void} session.requestControl asks for this page to order the session's inputs
     * @param {function(boolean): void} [session.setTakeOnKey] sets whether a key press takes control, for everyone;
     * without it, the option only shows what the host has set
     */
    constructor(
        { name, link, saveReport, copyLink, requestControl, setTakeOnKey },
        root = document.getElementById("session-panel"),
        pane = document.getElementById("session-pane"),
    ) {
        this.root = root;
        this.pane = pane;
        if (!root || !pane) return;
        root.hidden = false;
        this.floating = new FloatingPanel({
            panel: pane,
            header: pane.querySelector(".session-pane-header"),
            closeButton: pane.querySelector(".session-pane-close"),
        });
        const readout = root.querySelector(".slot-readout");
        readout.addEventListener("click", () => this.floating.toggle());
        for (const event of ["open", "close"])
            this.floating.addEventListener(event, () => readout.setAttribute("aria-expanded", this.floating.isOpen));
        const onResize = () => this.sitAboveLights();
        this.floating.addEventListener("open", () => {
            this.sitAboveLights();
            window.addEventListener("resize", onResize);
        });
        this.floating.addEventListener("close", () => window.removeEventListener("resize", onResize));
        pane.querySelector(".session-you").textContent = `You are ${name}`;
        pane.querySelector(".session-link").textContent = link;
        pane.querySelector(".session-copy-link").addEventListener("click", () => copyLink());
        pane.querySelector(".session-report").addEventListener("click", () => saveReport());
        // Neither keeps the focus a click gives it: the keyboard is the machine's.
        const take = pane.querySelector(".session-take");
        take.addEventListener("click", () => {
            take.blur();
            requestControl();
        });
        this.takeOnKey = pane.querySelector(".session-take-on-key");
        this.takeOnKey.disabled = !setTakeOnKey;
        this.takeOnKey.addEventListener("change", () => {
            this.takeOnKey.blur();
            setTakeOnKey?.(this.takeOnKey.checked);
        });
    }

    open() {
        this.floating?.open();
    }

    // The lights wrap onto more rows as the window narrows, so their height is measured, not assumed, and the
    // pane is kept short enough that its header stays on screen. A pane that has been dragged stays where it was
    // put, as tall as the window allows, and FloatingPanel keeps it inside the window.
    sitAboveLights() {
        if (this.pane.style.top) {
            this.pane.style.maxHeight = "";
            return;
        }
        const lightsTop = this.root.closest("#leds").getBoundingClientRect().top;
        this.pane.style.bottom = `${window.innerHeight - lightsTop + PaneGapPx}px`;
        this.pane.style.maxHeight = `${Math.max(0, lightsTop - 2 * PaneGapPx)}px`;
    }

    /** Shows whether a key press takes control, as the host has set it. */
    showTakeOnKey(on) {
        if (this.takeOnKey) this.takeOnKey.checked = on;
    }

    /**
     * Says who orders the session's inputs, `who` ("you" for this page), and whether this page can ask to: the
     * button greys out rather than going, so the pane keeps its shape.
     */
    showControl(who, canTake) {
        if (!this.floating) return;
        this.pane.querySelector(".session-control").textContent = who ? `In control: ${who}` : "";
        this.pane.querySelector(".session-take").disabled = !canTake;
    }

    /**
     * Shows `heading` over `summary` and a light for each of `peers` (`{ label, state }`, and what
     * peerDetail takes), each of which also gets a row in the pane.
     */
    show(heading, summary, peers) {
        if (!this.floating) return;
        this.root.querySelector(".session-heading").textContent = heading;
        this.root.querySelector(".session-summary").textContent = summary;
        this.root.querySelector(".session-peers").replaceChildren(...peers.map(light));
        this.pane.querySelector(".session-people tbody").replaceChildren(...peers.map(peerRow));
    }
}

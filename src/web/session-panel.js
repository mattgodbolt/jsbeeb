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
        cell(peer.label),
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
     */
    constructor(
        { name, link, saveReport, copyLink },
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
        root.querySelector(".slot-readout").addEventListener("click", () => this.floating.toggle());
        pane.querySelector(".session-you").textContent = `You are ${name}`;
        pane.querySelector(".session-link").textContent = link;
        pane.querySelector(".session-copy-link").addEventListener("click", () => copyLink());
        pane.querySelector(".session-report").addEventListener("click", () => saveReport());
    }

    open() {
        this.floating?.open();
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

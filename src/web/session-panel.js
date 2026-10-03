// The session's readout in the lights along the bottom of the page: a light for each
// peer, so how everyone is doing can be seen at a glance, and a menu with the numbers
// behind each and the session's report to save.

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

export class SessionPanel {
    constructor(name, { saveReport, copyLink }, root = document.getElementById("session-panel")) {
        this.root = root;
        if (!root) return;
        root.hidden = false;
        root.querySelector(".session-you").textContent = `You are ${name}`;
        for (const [selector, run] of [
            [".session-report", saveReport],
            [".session-copy-link", copyLink],
        ]) {
            root.querySelector(selector).addEventListener("click", (event) => {
                event.preventDefault();
                run();
            });
        }
    }

    /**
     * Shows `heading` over `summary` and a light for each of `peers` (`{ label, state }`, and what
     * peerDetail takes), each of which also gets a line in the menu.
     */
    show(heading, summary, peers) {
        if (!this.root) return;
        this.root.querySelector(".session-heading").textContent = heading;
        this.root.querySelector(".session-summary").textContent = summary;
        this.root.querySelector(".session-peers").replaceChildren(
            ...peers.map((peer) => {
                const light = document.createElement("span");
                light.className = "led session";
                light.classList.toggle("on", peer.state !== "connecting");
                light.dataset.state = peer.state;
                light.title = `${peer.label}: ${peerDetail(peer)}`;
                return light;
            }),
        );
        const menu = this.root.querySelector(".session-menu");
        for (const line of menu.querySelectorAll(".session-peer")) line.remove();
        menu.prepend(
            ...peers.map((peer) => {
                const line = document.createElement("li");
                line.className = "session-peer";
                const text = document.createElement("span");
                text.className = "dropdown-item-text";
                text.textContent = `${peer.label}: ${peerDetail(peer)}`;
                line.append(text);
                return line;
            }),
        );
    }
}

// What a shared session saw, kept so that whoever's session went wrong can save it as a
// report and send it to whoever is diagnosing it. Nothing leaves the page unless they do.

// About an hour and a half of a session with one guest.
const MaxEvents = 20000;
export const StatsIntervalMs = 1000;

const rounded = (ms) => Math.round(ms * 10) / 10;

export class SessionLog {
    constructor(details, now = () => performance.now()) {
        this.details = details;
        this.now = now;
        this.startMs = now();
        this.startedAt = new Date().toISOString();
        this.events = [];
        this.droppedEvents = 0;
    }

    /** Milliseconds since the session started on this page: the time every event carries. */
    elapsed() {
        return rounded(this.now() - this.startMs);
    }

    record(event, fields = {}) {
        if (this.events.length >= MaxEvents) {
            this.events.shift();
            ++this.droppedEvents;
        }
        this.events.push({ ms: this.elapsed(), event, ...fields });
    }

    report(state = {}) {
        const { details, startedAt, droppedEvents, events } = this;
        return {
            ...details,
            startedAt,
            savedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            droppedEvents,
            ...state,
            events,
        };
    }
}

/**
 * Counts and peaks gathered over StatsIntervalMs, and handed over as one summary at
 * the end of it, so a steady stream of frames and commits costs one event a second.
 */
export class IntervalStats {
    constructor(now = () => performance.now()) {
        this.now = now;
        this.lastTickMs = {};
        this.start(now());
    }

    start(ms) {
        this.sinceMs = ms;
        this.values = {};
    }

    count(name) {
        this.values[name] = (this.values[name] ?? 0) + 1;
    }

    peak(name, value) {
        this.values[name] = Math.max(this.values[name] ?? value, value);
    }

    /** Counts `name`, and keeps the longest wait since the last one as `${name}MaxGapMs`. */
    tick(name) {
        const ms = this.now();
        const lastMs = this.lastTickMs[name];
        this.lastTickMs[name] = ms;
        this.count(name);
        if (lastMs !== undefined) this.peak(`${name}MaxGapMs`, rounded(ms - lastMs));
    }

    /** The summary of the interval if it has run its course, starting the next; otherwise null. */
    take() {
        const ms = this.now();
        if (ms - this.sinceMs < StatsIntervalMs) return null;
        const summary = this.values;
        this.start(ms);
        return summary;
    }
}

/** The `keys` of a peer's summary that hold numbers, and nothing else of it, since it goes into the log. */
export function numbersFrom(summary, keys) {
    if (!summary || typeof summary !== "object") return {};
    return Object.fromEntries(keys.filter((key) => Number.isFinite(summary[key])).map((key) => [key, summary[key]]));
}

/**
 * Logs whether the page is visible and focused, now and at each change, and counts the main thread's long
 * tasks (Chrome reports those over 50 ms) into the interval `stats()` is gathering, until the function it
 * returns is called. A hidden tab's timers are throttled, so its machine falls behind.
 */
export function watchPage(log, stats) {
    const page = () => log.record("page", { hidden: document.hidden, focused: document.hasFocus() });
    const listeners = [
        [document, "visibilitychange"],
        [window, "focus"],
        [window, "blur"],
    ];
    for (const [target, event] of listeners) target.addEventListener(event, page);
    page();
    let observer = null;
    if (globalThis.PerformanceObserver?.supportedEntryTypes?.includes("longtask")) {
        observer = new PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
                stats().count("longTasks");
                stats().peak("longTaskMaxMs", rounded(entry.duration));
            }
        });
        observer.observe({ type: "longtask" });
    }
    return () => {
        for (const [target, event] of listeners) target.removeEventListener(event, page);
        observer?.disconnect();
    };
}

const defined = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

const byId = (report) => {
    const stats = new Map();
    report.forEach((entry) => stats.set(entry.id, entry));
    return stats;
};

/**
 * What the browser says about a connection: the round trip and the route its packets take
 * (`host` is a direct link on the same network, `srflx` through a NAT, `relay` via a TURN server).
 */
export async function connectionStats(pc) {
    const stats = byId(await pc.getStats());
    const all = [...stats.values()];
    const selectedId = all.find((entry) => entry.type === "transport")?.selectedCandidatePairId;
    // Firefox marks the pair in use as selected rather than naming it on the transport.
    const pair = stats.get(selectedId) ?? all.find((entry) => entry.type === "candidate-pair" && entry.selected);
    const channel = all.find((entry) => entry.type === "data-channel");
    const local = stats.get(pair?.localCandidateId);
    const remote = stats.get(pair?.remoteCandidateId);
    return defined({
        rttMs: pair?.currentRoundTripTime === undefined ? undefined : rounded(pair.currentRoundTripTime * 1000),
        route: local && remote ? `${local.candidateType}/${remote.candidateType}` : undefined,
        protocol: local?.protocol,
        packetsSent: pair?.packetsSent,
        packetsReceived: pair?.packetsReceived,
        messagesSent: channel?.messagesSent,
        messagesReceived: channel?.messagesReceived,
    });
}

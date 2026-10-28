// A shared session's host and guests joined in-process: what one end sends reaches the other in order, on a
// microtask of its own, as a data channel's messages come in tasks of their own, and a guest has its link before
// the host's first message reaches it, as a channel opens before anything comes on it.

class LinkEnd {
    constructor() {
        this.listener = null;
        this.other = null;
        this.open = false;
    }

    send(data) {
        if (!this.open) throw new Error("the link is not open");
        const copy = typeof data === "string" ? data : data.slice().buffer;
        queueMicrotask(() => this.other.open && this.other.listener.message(copy));
    }

    isOpen() {
        return this.open;
    }

    close() {
        if (!this.open) return;
        this.open = false;
        queueMicrotask(() => {
            if (!this.other.open) return;
            this.other.open = false;
            this.other.listener.closed("its channel closed");
        });
    }

    stats() {
        return Promise.resolve({ rttMs: 0, route: "host/host" });
    }
}

/** The host's end and a guest's end of one link, open once `open()` is called. */
function linkPair() {
    const host = new LinkEnd();
    const guest = new LinkEnd();
    host.other = guest;
    guest.other = host;
    return {
        host,
        guest,
        open() {
            host.open = guest.open = true;
        },
    };
}

/** A transport (see session-transport.js) whose guests join whichever host last listened, at once. */
export function inProcessTransport() {
    let room = null;
    return {
        createRoom: async () => "secret",
        listen(_room, _secret, host) {
            room = host;
            return { close: () => (room = room === host ? null : room) };
        },
        async join(_room, id, listener) {
            if (!room) throw new Error("there is no room to join");
            const pair = linkPair();
            pair.guest.listener = listener;
            pair.host.listener = room.connecting(id, pair.host);
            listener.offered();
            listener.answered();
            queueMicrotask(() => pair.open());
            return pair.guest;
        },
    };
}

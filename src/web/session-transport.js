// How a shared session's host and guests reach each other: a WebRTC data channel between the host and each guest,
// which the rendezvous only helps to open. The session itself sees only the links (see SessionLink) and never the
// browser's connections, so the tests can join a host and its guests in-process.

import { connectionStats } from "./session-log.js";
import { SessionFailures } from "./shared-session.js";

const IceServers = [{ urls: "stun:stun.l.google.com:19302" }];
export const IceGatheringTimeoutMs = 3000;
const HostPollMs = 1500;
const GuestPollMs = 1000;
export const AnswerTimeoutMs = 30000;
export const ConnectTimeoutMs = 20000;
// Offers anyone who knows the room's name can post; this bounds the connections in progress at once.
export const MaxConnectingGuests = 4;
const RoomGone = 404;

/**
 * One end of the ordered, reliable link between the host and a guest.
 * @typedef {object} SessionLink
 * @property {function(string|Uint8Array): void} send throws if the link cannot take it
 * @property {function(): boolean} isOpen
 * @property {function(): void} close
 * @property {function(): Promise<object>} stats the connection's round trip and route, as connectionStats has them
 */

/**
 * What a link tells the end it belongs to: `message` with each string or ArrayBuffer that comes, and `closed` with
 * why when the other end goes, or, for a host's end, never opens; a guest's is told when its offer has been posted
 * and its answer has come, and one that never opens rejects `join`.
 * @typedef {object} LinkListener
 * @property {function(string|ArrayBuffer): void} message
 * @property {function(string): void} closed
 * @property {function(): void} [offered]
 * @property {function(): void} [answered]
 */

/**
 * What a host hears from the room it listens on.
 * @typedef {object} RoomListener
 * @property {function(string, SessionLink): LinkListener} connecting a guest of this ID is connecting over the link
 * @property {function(): void} reopened the room had expired, and is open again
 * @property {function(Error): void} gone the room has gone and could not be made again, so nobody else can join
 */

const timedOut = (message) => Object.assign(new Error(message), { sessionFailure: SessionFailures.timeout });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const hasCandidate = (pc) => /^a=candidate:/m.test(pc.localDescription?.sdp ?? "");

// The rendezvous carries one offer and one answer per guest, so each side waits
// for its candidates before sending its description rather than trickling them:
// all of them, or those found within IceGatheringTimeoutMs of the first.
async function gatheredDescription(pc) {
    const listening = new AbortController();
    const timers = [];
    try {
        await new Promise((resolve, reject) => {
            const gathered = () => pc.iceGatheringState === "complete";
            if (gathered()) return resolve();
            let found = false;
            const foundOne = () => {
                if (found) return;
                found = true;
                timers.push(setTimeout(resolve, IceGatheringTimeoutMs));
            };
            const { signal } = listening;
            pc.addEventListener("icegatheringstatechange", () => gathered() && resolve(), { signal });
            pc.addEventListener("icecandidate", ({ candidate }) => candidate && foundOne(), { signal });
            if (hasCandidate(pc)) foundOne();
            timers.push(
                setTimeout(() => found || reject(timedOut("found no address to connect from")), ConnectTimeoutMs),
            );
        });
    } finally {
        listening.abort();
        timers.forEach(clearTimeout);
    }
    return pc.localDescription.sdp;
}

function opened(channel) {
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(timedOut("couldn't connect directly")), ConnectTimeoutMs);
        channel.addEventListener("open", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/** A link over `pc`, whose channel is `channel()` once there is one. */
function peerLink(pc, channel) {
    const isOpen = () => channel()?.readyState === "open";
    return {
        send(data) {
            if (!isOpen()) throw new Error("the channel is not open");
            channel().send(data);
        },
        isOpen,
        close: () => pc.close(),
        stats: () => connectionStats(pc),
    };
}

function listenTo(channel, listener, closed = () => false) {
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", ({ data }) => closed() || listener.message(data));
}

/**
 * The browser's transport: WebRTC data channels, opened through `rendezvous`.
 * @param {ReturnType<typeof import("./rendezvous-client.js").createRendezvousClient>} rendezvous
 */
export function webRtcTransport(rendezvous) {
    return {
        /** @returns {Promise<string>} the room's secret */
        createRoom: (room) => rendezvous.createRoom(room),

        /**
         * Answers the guests that ask to join `room` until it is closed, which deletes the room. Each guest's link
         * is the host's to close.
         * @param {RoomListener} host
         * @returns {{close: function(): void}}
         */
        listen(room, secret, host) {
            let listening = true;
            const offersSeen = new Set();
            const connecting = new Set();

            async function answer({ guest: id, sdp }) {
                const pc = new RTCPeerConnection({ iceServers: IceServers });
                let channel = null;
                let closed = false;
                const link = {
                    ...peerLink(pc, () => channel),
                    close() {
                        closed = true;
                        connecting.delete(link);
                        pc.close();
                    },
                };
                connecting.add(link);
                const listener = host.connecting(id, link);
                const fail = (reason) => {
                    if (closed) return;
                    closed = true;
                    connecting.delete(link);
                    listener.closed(reason);
                };
                // A guest has one channel; another would cost the host a snapshot each.
                pc.addEventListener("datachannel", ({ channel: offered }) => {
                    if (channel) return;
                    channel = offered;
                    listenTo(channel, listener, () => closed);
                    channel.addEventListener("close", () => fail("its channel closed"));
                    opened(channel).then(
                        () => connecting.delete(link),
                        () => fail("its channel never opened"),
                    );
                });
                setTimeout(() => channel || fail("it never opened a channel"), ConnectTimeoutMs);
                try {
                    await pc.setRemoteDescription({ type: "offer", sdp });
                    await pc.setLocalDescription(await pc.createAnswer());
                    const description = await gatheredDescription(pc);
                    if (closed) return;
                    await rendezvous.postAnswer(room, secret, id, description);
                } catch (error) {
                    console.warn(`Shared session: answering ${id} failed: ${error.message}`);
                    fail(`answering it failed: ${error.message}`);
                }
            }

            // A host that slept, or a dev server that restarted, finds its room gone; nobody
            // could join it again until it is made afresh.
            async function reopen() {
                try {
                    secret = await rendezvous.createRoom(room);
                    host.reopened();
                } catch (error) {
                    host.gone(error);
                    listening = false;
                }
            }

            (async () => {
                while (listening) {
                    try {
                        const offers = await rendezvous.listOffers(room, secret);
                        if (!listening) return;
                        // Each offer is answered once: one whose answer failed would otherwise be retried every poll.
                        for (const offer of offers) {
                            if (!offersSeen.has(offer.guest) && connecting.size < MaxConnectingGuests) {
                                offersSeen.add(offer.guest);
                                answer(offer);
                            }
                        }
                    } catch (error) {
                        if (error.status === RoomGone) {
                            await reopen();
                        } else {
                            console.warn(`Shared session: polling the rendezvous failed: ${error.message}`);
                        }
                    }
                    await delay(HostPollMs);
                }
            })();

            return {
                close() {
                    listening = false;
                    rendezvous.deleteRoom(room, secret).catch(() => {});
                },
            };
        },

        /**
         * Offers to join `room` as `id`, and waits for the host to answer and the channel to open.
         * @param {LinkListener} listener
         * @returns {Promise<SessionLink>}
         */
        async join(room, id, listener) {
            const pc = new RTCPeerConnection({ iceServers: IceServers });
            const channel = pc.createDataChannel("session", { ordered: true });
            listenTo(channel, listener);
            channel.addEventListener("close", () => listener.closed("lost the host"));
            try {
                await pc.setLocalDescription(await pc.createOffer());
                await rendezvous.postOffer(room, id, await gatheredDescription(pc));
                listener.offered();
                const answer = await awaitAnswer(rendezvous, room, id);
                listener.answered();
                await pc.setRemoteDescription({ type: "answer", sdp: answer });
                await opened(channel);
            } catch (error) {
                pc.close();
                throw error;
            }
            return peerLink(pc, () => channel);
        },
    };
}

async function awaitAnswer(rendezvous, room, id) {
    const deadline = Date.now() + AnswerTimeoutMs;
    while (Date.now() < deadline) {
        const answer = await rendezvous.getAnswer(room, id);
        if (answer) return answer;
        await delay(GuestPollMs);
    }
    throw timedOut("the host isn't answering");
}

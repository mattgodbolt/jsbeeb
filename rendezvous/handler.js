import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";

export const PathPrefix = "/api/rendezvous";
export const MaxBodyBytes = 16 * 1024;
export const MaxPendingOffers = 8;
export const RoomLifetimeSeconds = 10 * 60;
// Longer than a guest waits for its answer, so an offer cannot expire under a guest still waiting.
export const OfferLifetimeSeconds = 60;

export const SecretBytes = 32;
const IdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const RoomEntry = "room";
const OfferPrefix = "offer#";
const AnswerPrefix = "answer#";
const SecretHeader = "x-host-secret";

const offerEntry = (guest) => `${OfferPrefix}${guest}`;
const answerEntry = (guest) => `${AnswerPrefix}${guest}`;
const hashSecret = (secret) => createHash("sha256").update(secret).digest("base64url");

function respond(statusCode, body, extraHeaders = {}) {
    return {
        statusCode,
        headers: { "content-type": "application/json", "cache-control": "no-store", ...extraHeaders },
        body: JSON.stringify(body),
    };
}

const fail = (statusCode, error, extraHeaders) => respond(statusCode, { error }, extraHeaders);

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

function parseJsonBody(event) {
    const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
    if (raw.length > MaxBodyBytes) throw new HttpError(413, `Body exceeds ${MaxBodyBytes} bytes`);
    try {
        return JSON.parse(raw.toString("utf8"));
    } catch (_) {
        throw new HttpError(400, "Body is not valid JSON");
    }
}

function parseGuestSdp(event) {
    const body = parseJsonBody(event);
    const guest = body?.guest;
    const sdp = body?.sdp;
    if (typeof guest !== "string" || !IdPattern.test(guest)) throw new HttpError(400, "Bad guest ID");
    if (typeof sdp !== "string" || sdp.length === 0) throw new HttpError(400, "Missing sdp");
    return { guest, sdp };
}

const Routes = [
    { pattern: /^\/room\/([^/]+)$/, methods: { POST: "createRoom", DELETE: "deleteRoom" } },
    { pattern: /^\/room\/([^/]+)\/offer$/, methods: { POST: "postOffer" } },
    { pattern: /^\/room\/([^/]+)\/offers$/, methods: { GET: "listOffers" } },
    { pattern: /^\/room\/([^/]+)\/answer$/, methods: { POST: "postAnswer" } },
    { pattern: /^\/room\/([^/]+)\/answer\/([^/]+)$/, methods: { GET: "getAnswer" } },
];

/**
 * Builds the rendezvous request handler.
 *
 * Items are `{room, entry, expires, ...}` with `expires` in epoch seconds. A room is the `room` entry holding
 * `secretHash`; each guest has an `offer#<guest>` entry and, once the host has answered, an `answer#<guest>`
 * entry sharing the offer's expiry. Anything at or past its expiry is treated as absent.
 *
 * @param {object} options
 * @param {import("./memory-store.js").RendezvousStore} options.store
 * @param {() => number} [options.now] milliseconds since the epoch
 * @param {(size: number) => Buffer} [options.randomBytes]
 * @returns {(event: object) => Promise<{statusCode: number, headers: object, body: string}>} takes a Lambda
 *     function URL (payload v2) event
 */
export function createHandler({ store, now = Date.now, randomBytes = cryptoRandomBytes }) {
    const nowSeconds = () => Math.floor(now() / 1000);
    const isLive = (item) => item !== undefined && item.expires > nowSeconds();

    async function liveItem(room, entry, missing) {
        const item = await store.get(room, entry);
        if (!isLive(item)) throw new HttpError(404, missing);
        return item;
    }

    const liveRoom = (room) => liveItem(room, RoomEntry, "No such room");
    const liveOffer = (room, guest) => liveItem(room, offerEntry(guest), "No such offer");

    async function hostRoom(room, event) {
        const item = await liveRoom(room);
        const secret = event.headers?.[SecretHeader];
        const expected = Buffer.from(item.secretHash);
        const given = Buffer.from(typeof secret === "string" ? hashSecret(secret) : "");
        if (given.length !== expected.length || !timingSafeEqual(given, expected))
            throw new HttpError(403, "Bad host secret");
        return item;
    }

    async function pendingOffers(room) {
        const items = (await store.query(room)).filter(isLive);
        const answered = new Set(items.map((item) => item.entry));
        return items
            .filter((item) => item.entry.startsWith(OfferPrefix))
            .map((item) => ({ guest: item.entry.slice(OfferPrefix.length), sdp: item.sdp }))
            .filter(({ guest }) => !answered.has(answerEntry(guest)));
    }

    const actions = {
        async createRoom(event, room) {
            const secret = randomBytes(SecretBytes).toString("base64url");
            const item = {
                room,
                entry: RoomEntry,
                secretHash: hashSecret(secret),
                expires: nowSeconds() + RoomLifetimeSeconds,
            };
            if (!(await store.put(item, { unlessLiveAt: nowSeconds() }))) return fail(409, "Room already exists");
            return respond(201, { secret });
        },

        async deleteRoom(event, room) {
            await hostRoom(room, event);
            for (const { entry } of await store.query(room)) await store.delete(room, entry);
            return respond(200, {});
        },

        async postOffer(event, room) {
            const { guest, sdp } = parseGuestSdp(event);
            await liveRoom(room);
            if ((await pendingOffers(room)).length >= MaxPendingOffers) return fail(429, "Too many pending offers");
            const item = { room, entry: offerEntry(guest), sdp, expires: nowSeconds() + OfferLifetimeSeconds };
            if (!(await store.put(item, { unlessLiveAt: nowSeconds() }))) return fail(409, "Offer already pending");
            return respond(201, {});
        },

        async listOffers(event, room) {
            const roomItem = await hostRoom(room, event);
            // Only over a room that is still there, so a delete racing this poll is not undone.
            await store.put({ ...roomItem, expires: nowSeconds() + RoomLifetimeSeconds }, { ifPresent: true });
            return respond(200, { offers: await pendingOffers(room) });
        },

        async postAnswer(event, room) {
            const { guest, sdp } = parseGuestSdp(event);
            await hostRoom(room, event);
            const offer = await liveOffer(room, guest);
            await store.put({ room, entry: answerEntry(guest), sdp, expires: offer.expires });
            return respond(201, {});
        },

        async getAnswer(event, room, guest) {
            if (!IdPattern.test(guest)) throw new HttpError(400, "Bad guest ID");
            await liveRoom(room);
            await liveOffer(room, guest);
            const answer = await store.get(room, answerEntry(guest));
            return isLive(answer) ? respond(200, { sdp: answer.sdp }) : respond(202, {});
        },
    };

    return async (event) => {
        const rawPath = event.rawPath ?? "";
        if (!rawPath.startsWith(`${PathPrefix}/`)) return fail(404, "Not found");
        const path = rawPath.slice(PathPrefix.length);
        const method = event.requestContext?.http?.method;
        for (const { pattern, methods } of Routes) {
            const match = pattern.exec(path);
            if (!match) continue;
            const action = Object.hasOwn(methods, method) ? methods[method] : undefined;
            if (!action) return fail(405, "Method not allowed", { allow: Object.keys(methods).join(", ") });
            const [, room, ...rest] = match;
            if (!IdPattern.test(room)) return fail(400, "Bad room ID");
            try {
                return await actions[action](event, room, ...rest);
            } catch (error) {
                if (error instanceof HttpError) return fail(error.statusCode, error.message);
                console.error(`Rendezvous ${action} failed:`, error);
                return fail(500, "Internal error");
            }
        }
        return fail(404, "Not found");
    };
}

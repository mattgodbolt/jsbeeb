const DefaultBase = "/api/rendezvous";
const SecretHeader = "x-host-secret";
const AnswerPending = 202;

export class RendezvousError extends Error {
    constructor(message, status) {
        super(message);
        this.name = "RendezvousError";
        this.status = status;
    }
}

/**
 * The browser's side of the rendezvous API (rendezvous/handler.js).
 *
 * @param {object} [options]
 * @param {string} [options.base]
 * @param {typeof fetch} [options.fetch]
 */
export function createRendezvousClient({ base = DefaultBase, fetch: fetchFn = globalThis.fetch } = {}) {
    async function request(what, method, path, { secret, body, keepalive = false } = {}) {
        const headers = {};
        if (secret !== undefined) headers[SecretHeader] = secret;
        if (body !== undefined) headers["content-type"] = "application/json";
        const response = await fetchFn(`${base}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: "no-store",
            keepalive,
        });
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = json.error ? `: ${json.error}` : "";
            throw new RendezvousError(
                `Rendezvous ${what} failed with status ${response.status}${detail}`,
                response.status,
            );
        }
        return { status: response.status, json };
    }

    const roomPath = (room) => `/room/${encodeURIComponent(room)}`;

    return {
        /** @returns {Promise<string>} the host secret */
        async createRoom(room) {
            return (await request("create room", "POST", roomPath(room))).json.secret;
        },
        /** Survives the page unloading, so a host can call it as it goes. */
        async deleteRoom(room, secret) {
            await request("delete room", "DELETE", roomPath(room), { secret, keepalive: true });
        },
        async postOffer(room, guest, sdp) {
            await request("post offer", "POST", `${roomPath(room)}/offer`, { body: { guest, sdp } });
        },
        /** @returns {Promise<{guest: string, sdp: string}[]>} offers not yet answered */
        async listOffers(room, secret) {
            return (await request("list offers", "GET", `${roomPath(room)}/offers`, { secret })).json.offers;
        },
        async postAnswer(room, secret, guest, sdp) {
            await request("post answer", "POST", `${roomPath(room)}/answer`, { secret, body: { guest, sdp } });
        },
        /** @returns {Promise<string | null>} the answer's SDP, or null while the host has not answered */
        async getAnswer(room, guest) {
            const path = `${roomPath(room)}/answer/${encodeURIComponent(guest)}`;
            const { status, json } = await request("get answer", "GET", path);
            return status === AnswerPending ? null : json.sdp;
        },
    };
}

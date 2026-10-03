import { createHandler, MaxBodyBytes, PathPrefix } from "./handler.js";
import { createMemoryStore } from "./memory-store.js";

async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > MaxBodyBytes) break;
    }
    return Buffer.concat(chunks);
}

/**
 * Converts a Node request into the Lambda function URL (payload v2) event the handler expects.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {Buffer} body
 */
export function toFunctionUrlEvent(req, body) {
    const url = new URL(req.originalUrl ?? req.url, "http://localhost");
    const headers = Object.fromEntries(
        Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value]),
    );
    return {
        rawPath: url.pathname,
        rawQueryString: url.search.slice(1),
        headers,
        requestContext: { http: { method: req.method } },
        body: body.length > 0 ? body.toString("base64") : undefined,
        isBase64Encoded: body.length > 0,
    };
}

function mountRendezvous(middlewares) {
    const handler = createHandler({ store: createMemoryStore() });
    middlewares.use(PathPrefix, async (req, res, next) => {
        try {
            const response = await handler(toFunctionUrlEvent(req, await readBody(req)));
            res.writeHead(response.statusCode, response.headers);
            res.end(response.body);
        } catch (error) {
            next(error);
        }
    });
}

/**
 * Serves the rendezvous API from memory under the dev and preview servers, so sessions work locally with no AWS.
 *
 * @returns {import("vite").Plugin}
 */
export function rendezvousPlugin() {
    return {
        name: "jsbeeb-rendezvous",
        configureServer: (server) => mountRendezvous(server.middlewares),
        configurePreviewServer: (server) => mountRendezvous(server.middlewares),
    };
}

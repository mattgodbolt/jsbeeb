import { stringToUint8Array } from "./binary.js";

export const runningInNode = typeof window === "undefined";

/** Why a disc or tape could not be loaded, in terms general enough to report. */
export const LoadFailures = Object.freeze({
    notFound: "not_found",
    http: "http",
    network: "network",
    unauthorised: "unauthorised",
    badImage: "bad_image",
    other: "other",
});

/** `error`, saying it failed for `reason` unless it already says why. */
export function failedFor(error, reason) {
    if (!error.loadFailure) error.loadFailure = reason;
    return error;
}

/** What `make` resolves to, any failure of it failing for `reason` unless it already says why. */
export async function failingFor(reason, make) {
    try {
        return await make();
    } catch (error) {
        throw failedFor(error, reason);
    }
}

const httpFailure = (url, status) =>
    failedFor(
        new Error(`Unable to load ${url}, http code ${status}`),
        status === 404 ? LoadFailures.notFound : LoadFailures.http,
    );

/** The bytes at `url`, fetched, failing as `not_found`, `http` or `network`. */
export async function fetchBytes(url) {
    const response = await failingFor(LoadFailures.network, () => fetch(url));
    if (!response.ok) throw httpFailure(url, response.status);
    return new Uint8Array(await response.arrayBuffer());
}

function loadDataHttp(url) {
    return new Promise(function (resolve, reject) {
        const request = new XMLHttpRequest();
        request.open("GET", url, true);
        request.overrideMimeType("text/plain; charset=x-user-defined");
        request.onload = function () {
            if (request.status !== 200) {
                reject(httpFailure(url, request.status));
                return;
            }
            if (typeof request.response !== "string") {
                resolve(request.response);
            } else {
                resolve(stringToUint8Array(request.response));
            }
        };
        request.onerror = function () {
            reject(failedFor(new Error(`A network error occurred loading ${url}`), LoadFailures.network));
        };
        request.send(null);
    });
}

let _nodeBasePath = null;

export function setNodeBasePath(basePath) {
    _nodeBasePath = basePath;
}

async function loadDataNode(url) {
    if (url.startsWith("file:")) {
        const fs = await import("fs");
        const { fileURLToPath } = await import("url");
        return fs.readFileSync(fileURLToPath(url));
    }
    if (/^https?:\/\//.test(url)) return fetchBytes(url);
    const fs = await import("fs");
    const nodePath = await import("path");
    if (_nodeBasePath) {
        const publicPath = nodePath.join(_nodeBasePath, "public", url);
        if (fs.existsSync(publicPath)) return fs.readFileSync(publicPath);
        return fs.readFileSync(nodePath.join(_nodeBasePath, url));
    }
    if (url[0] === "/") url = "." + url;
    if (fs.existsSync("public/" + url)) return fs.readFileSync("public/" + url);
    return fs.readFileSync(url);
}

export function loadData(url) {
    if (runningInNode) {
        return loadDataNode(url);
    } else {
        return loadDataHttp(url);
    }
}

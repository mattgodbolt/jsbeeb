import { stringToUint8Array } from "./binary.js";

export const runningInNode = typeof window === "undefined";

function loadDataHttp(url) {
    return new Promise(function (resolve, reject) {
        const request = new XMLHttpRequest();
        request.open("GET", url, true);
        request.overrideMimeType("text/plain; charset=x-user-defined");
        request.onload = function () {
            if (request.status !== 200) {
                reject(new Error("Unable to load " + url + ", http code " + request.status));
                return;
            }
            if (typeof request.response !== "string") {
                resolve(request.response);
            } else {
                resolve(stringToUint8Array(request.response));
            }
        };
        request.onerror = function () {
            reject(new Error("A network error occurred loading " + url));
        };
        request.send(null);
    });
}

let _nodeBasePath = null;

export function setNodeBasePath(basePath) {
    _nodeBasePath = basePath;
}

async function loadDataNode(url) {
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

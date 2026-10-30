import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// jsdom makes utils.loadData take the browser branch, so back XMLHttpRequest
// with the files the dev server would serve.
export class FileBackedXhr {
    open(_method, url) {
        this._url = url;
    }

    overrideMimeType() {}

    send() {
        const served = path.join(RepoRoot, "public", this._url);
        const file = existsSync(served) ? served : path.join(RepoRoot, this._url);
        try {
            this.response = new Uint8Array(readFileSync(file));
            this.status = 200;
        } catch {
            this.status = 404;
        }
        this.onload();
    }
}

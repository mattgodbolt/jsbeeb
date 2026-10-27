import { unzipDiscImage, unzipRomImage } from "./archive.js";
import { stringToUint8Array } from "./binary.js";
import { failingFor, loadData, LoadFailures } from "./loader.js";

/** Splits an image reference into its schema (empty for a bare name) and the image it names. */
export function splitImage(image) {
    const match = image.match(/(([^:]+):\/?\/?|[!^|])?(.*)/);
    return { schema: match[2] || match[1] || "", image: match[3] };
}

/**
 * Every schema a reference can start with: how it is served (`route`) and where the page says it
 * came from, as a media-catalogue source key (`source`) or as words (`phrase`). A reference
 * with no schema is a bare name from the built-in folder. A schema with no source is `personal`
 * when what it names is the user's own, as a source in media-catalogue's `Sources` is.
 */
export const Schemas = Object.freeze({
    "": { route: "folder", source: "builtin" },
    sth: { route: "sth", source: "sth" },
    "|": { route: "sth", source: "sth" },
    hfe: { route: "hfe", source: "hfe" },
    bitshifters: { route: "bitshifters", source: "bitshifters" },
    github: { route: "github", source: "github" },
    gd: { route: "drive", source: "gdrive" },
    local: { route: "browser", source: "browser" },
    "!": { route: "browser", source: "browser" },
    session: { route: "session", source: "session" },
    data: { route: "zipped-inline", phrase: "the URL", personal: true },
    b64data: { route: "inline", phrase: "the URL", personal: true },
    http: { route: "url", phrase: "the web" },
    https: { route: "url", phrase: "the web" },
    file: { route: "url", phrase: "a file", personal: true },
});

/** How a reference is served; a schema this page does not know is read as a folder name. */
export const routeOf = (ref) => (Schemas[splitImage(ref).schema] ?? Schemas[""]).route;

const GitHubRawBase = "https://raw.githubusercontent.com";
const GitHubApiBase = "https://api.github.com";
const GitHubDefaultRef = "HEAD";
const GitHubLatestReleaseRef = "~latest";

/** Splits a `github:` reference's `<owner>/<repo>[@<ref>]/<path>`; no ref is the default branch. */
function parseGitHubLocation(location) {
    const match = location.match(/^([^/@]+)\/([^/@]+)(?:@([^/]+))?\/(.+)$/);
    if (!match) throw new Error(`A github: reference is owner/repo/path or owner/repo@ref/path, not "${location}"`);
    const [, owner, repo, ref = GitHubDefaultRef, path] = match;
    return { owner, repo, ref, path };
}

function gitHubRawUrl({ owner, repo, ref, path }) {
    return [GitHubRawBase, ...[owner, repo, ref, ...path.split("/")].map(encodeURIComponent)].join("/");
}

// Where a bare name is looked for, which registered source serves the archive, and which files a zip is opened for.
const Kinds = {
    disc: { folder: "discs", sth: "sth", unzip: unzipDiscImage },
    tape: { folder: "tapes", sth: "tapeSth", unzip: unzipDiscImage },
    rom: { folder: "roms", unzip: unzipRomImage },
};

const unzipped = (kind, data) => failingFor(LoadFailures.badImage, () => Kinds[kind].unzip(data));

const openAs = (kind, name, data) => (/\.zip/i.test(name) ? unzipped(kind, data) : { name, data, ignored: [] });

/** The disc or tape itself when `name` is a zip, else the bytes as given, either way as `{ name, data, ignored }`. */
export function openIfZip(name, data) {
    return openAs("disc", name, data);
}

/**
 * Turns any image reference the URL can name into bytes, `{ name, data, ignored }`,
 * for a disc, a tape or a sideways ROM: the archives through the sources registered for them,
 * `data:` and `b64data:` inline, `http:`, `https:` and `file:` by URL, `github:`
 * by the URL of its raw file, and a bare name from the built-in folder. Zips
 * are opened once, here. Nothing in it needs a page, so a headless machine can
 * load the same references.
 */
export class MediaResolver {
    constructor({ load = loadData } = {}) {
        this.sources = {};
        this.load = load;
        this._latestReleaseTags = new Map();
    }

    /** Registers the fetcher behind an archive schema; each archive registers as it is constructed. */
    addSource(schema, fetcher) {
        this.sources[schema] = fetcher;
    }

    async resolve(kind, ref) {
        const { image } = splitImage(ref);
        const { folder, sth } = Kinds[kind];
        const route = routeOf(ref);
        switch (route) {
            case "sth":
                if (!sth) throw new Error(`Stairway to Hell has no ${kind} images, so "${ref}" cannot be loaded`);
                return this.source(sth)(image);
            case "hfe":
            case "bitshifters":
                return { name: image, data: await this.source(route)(image), ignored: [] };
            case "session":
                return this.source("session")(image);
            case "inline":
                return { name: "disk.ssd", data: stringToUint8Array(atob(image)), ignored: [] };
            case "zipped-inline":
                return unzipped(kind, stringToUint8Array(atob(image)));
            case "url":
                // The URL may end in query parameters, which would upset the extension check.
                return openAs(kind, new URL(ref).pathname.split("/").pop(), await this.load(ref));
            case "github":
                return this.resolveGitHub(kind, image);
            default:
                return openAs(kind, image, await this.load(`${folder}/${image}`));
        }
    }

    async resolveGitHub(kind, location) {
        const parsed = parseGitHubLocation(location);
        const ref = parsed.ref === GitHubLatestReleaseRef ? await this.latestReleaseTag(parsed) : parsed.ref;
        return openAs(kind, parsed.path.split("/").pop(), await this.load(gitHubRawUrl({ ...parsed, ref })));
    }

    /** The tag of a repo's latest release, asked once per repo per resolver; on any failure, the default branch. */
    latestReleaseTag({ owner, repo }) {
        const key = `${owner}/${repo}`;
        if (!this._latestReleaseTags.has(key))
            this._latestReleaseTags.set(key, this._fetchLatestReleaseTag(owner, repo));
        return this._latestReleaseTags.get(key);
    }

    async _fetchLatestReleaseTag(owner, repo) {
        const url = `${GitHubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
        try {
            const { tag_name: tag } = JSON.parse(new TextDecoder().decode(await this.load(url)));
            if (!tag) throw new Error("the release has no tag_name");
            return tag;
        } catch (error) {
            console.warn(
                `Couldn't find ${owner}/${repo}'s latest release, so loading its default branch: ${error.message}`,
            );
            return GitHubDefaultRef;
        }
    }

    source(schema) {
        const fetcher = this.sources[schema];
        if (!fetcher) throw new Error(`No ${schema} archive is available here`);
        return fetcher;
    }
}

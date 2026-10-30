import { StairwayToHell } from "../sth.js";
import { BbcDiscArchive } from "../bbcdiscs.js";
import { BitshiftersArchive } from "../bitshifters.js";
import GitHubDiscs from "./github-discs.json";
import {
    describeBitshiftersEntry,
    describeGitHubEntry,
    describeHfeEntry,
    describeSthDisc,
    describeSthTape,
} from "./media-catalogue.js";

/**
 * Registers the public archives with the loader: each one's fetcher, its list for the media window, and a describer
 * for those whose entries can name the machine they need.
 */
export function addArchiveSources(media) {
    const sthDiscs = new StairwayToHell();
    const sthTapes = new StairwayToHell({ tapes: true });
    media.addSource("sth", (name) => sthDiscs.fetch(name));
    media.addSource("tapeSth", (name) => sthTapes.fetch(name));
    media.addLister("sth", async () => [
        ...(await sthDiscs.catalogue()).map(describeSthDisc),
        ...(await sthTapes.catalogue()).map(describeSthTape),
    ]);

    const hfe = new BbcDiscArchive();
    media.addSource("hfe", (path) => hfe.fetch(path));
    media.addLister("hfe", async () => (await hfe.catalogue()).map(describeHfeEntry));

    const bitshifters = new BitshiftersArchive();
    media.addSource("bitshifters", (path) => bitshifters.fetch(path));
    media.addLister("bitshifters", async () => (await bitshifters.catalogue()).map(describeBitshiftersEntry));
    media.addDescriber("bitshifters", async (path) => {
        const entry = (await bitshifters.catalogue()).find((file) => file.path === path);
        return entry && describeBitshiftersEntry(entry);
    });

    const gitHubDiscs = GitHubDiscs.map(describeGitHubEntry);
    media.addLister("github", () => gitHubDiscs);
    media.addDescriber("github", (location) =>
        gitHubDiscs.find((descriptor) => descriptor.ref === `github:${location}`),
    );
}

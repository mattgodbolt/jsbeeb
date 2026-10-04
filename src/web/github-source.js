import GitHubDiscs from "./github-discs.json";
import { describeGitHubEntry } from "./media-catalogue.js";

/**
 * The discs listed in github-discs.json, which ships with the page, as a media source. Any
 * `github:` reference loads without it; this is what the window lists and what a link that
 * boots a listed disc learns its machine from.
 */
export class GitHubSource {
    constructor({ media }) {
        media.addLister("github", () => GitHubDiscs.map(describeGitHubEntry));
        media.addDescriber("github", (location) =>
            GitHubDiscs.map(describeGitHubEntry).find((descriptor) => descriptor.ref === `github:${location}`),
        );
    }
}

import GitHubDiscs from "./github-discs.json";
import { describeGitHubEntry } from "./media-catalogue.js";

/** The discs in github-discs.json, bundled with the page, as the media window's list and their describer. */
export class GitHubSource {
    constructor({ media }) {
        media.addLister("github", () => GitHubDiscs.map(describeGitHubEntry));
        media.addDescriber("github", (location) =>
            GitHubDiscs.map(describeGitHubEntry).find((descriptor) => descriptor.ref === `github:${location}`),
        );
    }
}

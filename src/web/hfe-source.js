import { BbcDiscArchive } from "../bbcdiscs.js";
import { describeHfeEntry } from "./media-catalogue.js";

/** The HFE archive as a media source: its catalogue with the metadata it carries, and its fetcher. */
export class HfeSource {
    constructor({ media }) {
        this.archive = new BbcDiscArchive();
        media.addSource("hfe", (path) => this.archive.fetch(path));
        media.addLister("hfe", async () => (await this.archive.catalogue()).map(describeHfeEntry));
    }
}

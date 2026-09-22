import { BitshiftersArchive } from "../bitshifters.js";
import { describeBitshiftersEntry } from "./media-catalogue.js";

/** Bitshifters' releases as a media source: their catalogue with the prod pages it names, and its fetcher. */
export class BitshiftersSource {
    constructor({ media }) {
        this.archive = new BitshiftersArchive();
        media.addSource("bitshifters", (path) => this.archive.fetch(path));
        media.addLister("bitshifters", async () => (await this.archive.catalogue()).map(describeBitshiftersEntry));
    }
}

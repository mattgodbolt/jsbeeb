import { StairwayToHell } from "../sth.js";
import { describeSthDisc, describeSthTape } from "./media-catalogue.js";

/** The Stairway to Hell mirror as a media source: its disc and tape catalogues, and their fetchers. */
export class SthSource {
    constructor({ media }) {
        this.discs = new StairwayToHell(false);
        this.tapes = new StairwayToHell(true);
        media.addSource("sth", (name) => this.discs.fetch(name));
        media.addSource("tapeSth", (name) => this.tapes.fetch(name));
        media.addLister("sth", async () => [
            ...(await this.discs.catalogue()).map(describeSthDisc),
            ...(await this.tapes.catalogue()).map(describeSthTape),
        ]);
    }
}

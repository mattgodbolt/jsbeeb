import { BitshiftersArchive } from "../bitshifters.js";
import { describeBitshiftersEntry } from "./media-catalogue.js";

const Schema = "bitshifters:";

/** Bitshifters' releases as a media source: their catalogue with the prod pages it names, and its fetcher. */
export class BitshiftersSource {
    constructor({ media }) {
        this.archive = new BitshiftersArchive();
        media.addSource("bitshifters", (path) => this.archive.fetch(path));
        media.addLister("bitshifters", async () => (await this.archive.catalogue()).map(describeBitshiftersEntry));
    }

    /**
     * @param {string} ref a reference as the URL gives it
     * @returns {Promise<object|null>} the descriptor of the release the reference names, or null for
     *     a reference of another source, a path the catalogue does not list or a catalogue out of reach
     */
    async describe(ref) {
        if (!ref.startsWith(Schema)) return null;
        const path = ref.slice(Schema.length);
        try {
            const entry = (await this.archive.catalogue()).find((file) => file.path === path);
            return entry ? describeBitshiftersEntry(entry) : null;
        } catch (error) {
            console.log(`Could not look up ${ref} in the Bitshifters catalogue: ${error}`);
            return null;
        }
    }
}

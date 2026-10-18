import { Schemas, splitImage } from "../media-resolver.js";
import { Sources } from "./media-catalogue.js";

/**
 * A media reference whole when anyone could name it (a catalogue entry, a built-in disc, a public URL), and only by
 * its source when it is the user's own.
 */
export function mediaLabel(ref) {
    if (!ref) return ref;
    const { schema } = splitImage(ref);
    const known = Schemas[schema] ?? Schemas[""];
    const personal = known.source ? Sources[known.source]?.personal : known.personal;
    return personal ? (known.source ?? schema) : ref;
}

/** Nothing of the value at all. */
export const redacted = () => "redacted";

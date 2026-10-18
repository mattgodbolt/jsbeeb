import { Schemas, splitImage } from "../media-resolver.js";
import { Sources } from "./media-catalogue.js";

const MaxErrorLabelLength = 100;
const QuotedText = /"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/g;
const Addresses = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\b(?:data|blob|file):\S+/gi;
const PeerBucketTops = [0, 1, 2, 4];

const schemaOf = (ref) => {
    const { schema } = splitImage(ref);
    return { schema, known: Schemas[schema] ?? Schemas[""] };
};

/** The `Sources` key a reference comes from, or its schema for one with no source of its own (`https`, `data`). */
export function sourceKey(ref) {
    const { schema, known } = schemaOf(ref);
    return known.source ?? schema;
}

/**
 * A media reference whole when anyone could name it (a catalogue entry, a built-in disc, a public URL), and only by
 * its source when it is the user's own.
 */
export function mediaLabel(ref) {
    if (!ref) return ref;
    const { known } = schemaOf(ref);
    const personal = known.source ? Sources[known.source]?.personal : known.personal;
    return personal ? sourceKey(ref) : ref;
}

/** Nothing of the value at all. */
export const redacted = () => "redacted";

/** An error message without what it quotes or the addresses it names, which may be the user's own. */
export function errorLabel(message) {
    return String(message)
        .replace(QuotedText, '""')
        .replace(Addresses, "<address>")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MaxErrorLabelLength);
}

/** A count of people, in buckets coarse enough that no session stands out by it. */
export function countBucket(count) {
    let bottom = 0;
    for (const top of PeerBucketTops) {
        if (count <= top) return bottom === top ? `${top}` : `${bottom}-${top}`;
        bottom = top + 1;
    }
    return `${bottom}+`;
}

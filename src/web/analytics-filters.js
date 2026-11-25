import { Schemas, splitImage } from "../media-resolver.js";
import { Sources } from "./media-catalogue.js";

const MaxErrorLabelLength = 100;
const QuotedText = /"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/g;
const Addresses = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\b(?:data|blob|file):\S+/gi;
const PeerBucketTops = [0, 1, 2, 4];
const LocalNetworkDomains = ["local", "localhost", "lan", "internal", "home.arpa", "ts.net"];
const DottedQuad = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
// The URL parser writes an IPv4-mapped IPv6 address as two hex groups.
const MappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

const schemaOf = (ref) => {
    const { schema } = splitImage(ref);
    return { schema, known: Schemas[schema] ?? Schemas[""] };
};

/** The `Sources` key a reference comes from, or its schema for one with no source of its own (`https`, `data`). */
export function sourceKey(ref) {
    const { schema, known } = schemaOf(ref);
    return known.source ?? schema;
}

function isPrivateIpv4([a, b]) {
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
}

function isPrivateIpv6(address) {
    const mapped = address.match(MappedIpv4);
    if (mapped) {
        const high = parseInt(mapped[1], 16);
        return isPrivateIpv4([high >> 8, high & 0xff]);
    }
    return ["::", "::1"].includes(address) || /^(f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]):/.test(address);
}

/** Whether `url` is on this machine or its network. */
function isOwnHost(url) {
    let hostname, protocol;
    try {
        ({ hostname, protocol } = new URL(url));
    } catch {
        return false;
    }
    if (protocol !== "http:" && protocol !== "https:") return false;
    const host = hostname.replace(/\.$/, "");
    if (host.startsWith("[")) return isPrivateIpv6(host.slice(1, -1));
    const quad = host.match(DottedQuad);
    if (quad) return isPrivateIpv4(quad.slice(1).map(Number));
    const inDomain = (domain) => host === domain || host.endsWith(`.${domain}`);
    return !host.includes(".") || LocalNetworkDomains.some(inDomain);
}

/**
 * A media reference whole when anyone could name it (a catalogue entry, a built-in disc, a public URL), and only by
 * its source when it is the user's own, including a URL on their own machine or network.
 */
export function mediaLabel(ref) {
    if (!ref) return ref;
    const { known } = schemaOf(ref);
    const personal = (known.source ? Sources[known.source]?.personal : known.personal) || isOwnHost(ref);
    return personal ? sourceKey(ref) : ref;
}

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

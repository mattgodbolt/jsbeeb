// The names the BBC can give a file, and how it spells a path to one.

import { Errors } from "./vdfs-errors.js";

export const MaxNameLength = 10;
export const LockedAttribute = 0x08;

const PrintableAscii = /^[!-~]*$/;
const NameSeparators = /[.:"*#|]/;
/** A name that ends in `/inf` would be a host file that ends in `.inf`, which is where a file's addresses are kept. */
const SidecarName = /\/inf$/i;
const SpecialDirectories = new Set(["$", "&", "@", "%", "^"]);

export function isValidName(name) {
    return (
        name.length > 0 &&
        name.length <= MaxNameLength &&
        PrintableAscii.test(name) &&
        !NameSeparators.test(name) &&
        !SidecarName.test(name) &&
        !SpecialDirectories.has(name)
    );
}

/** @returns {RegExp} what a `*` and `#` pattern matches, whatever the case. */
export function wildcardMatcher(pattern) {
    const source = [...pattern]
        .map((char) => (char === "*" ? ".*" : char === "#" ? "." : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")))
        .join("");
    return new RegExp(`^${source}$`, "i");
}

export const sameName = (a, b) => a.toUpperCase() === b.toUpperCase();

/**
 * Takes apart a name as the 6502 spells it: an optional `:0.` drive, then dot-separated parts, the first of which may
 * be `$` or `&` (the root) or `%` (the library); `^` (the parent) and `@` (the current directory) may be any.
 *
 * @returns {{base: "root" | "library" | "current", parts: string[]}} where it starts, and the parts to follow
 */
export function parsePath(text) {
    const withoutDrive = text.replace(/^:[^.]*\.?/, "");
    const parts = withoutDrive.length === 0 ? ["@"] : withoutDrive.split(".");
    const first = parts[0];
    const base = first === "$" || first === "&" ? "root" : first === "%" ? "library" : "current";
    const rest = base === "current" ? parts : parts.slice(1);
    if (!rest.every((part) => part === "^" || part === "@" || isValidName(part))) throw Errors.badName();
    return { base, parts: rest };
}

/** Throws for a path the BBC could not have made, and for the root, which no store writes. */
export function requireWritableName(volumePath) {
    if (volumePath.length === 0 || !volumePath.every(isValidName))
        throw new Error(`${volumePath.join(".") || "$"} is not a name VDFS can write`);
}

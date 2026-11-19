// How a VDFS volume kept in a host folder describes a file: a `.inf` file beside it, as BeebAsm, Baron and b-em keep
// them, and a `.` in a host name is a `/` to the 6502. Shared by the stores of a folder. See docs/vdfs.md.

import { hexUpper } from "./hex.js";
import { LockedAttribute } from "./vdfs-names.js";

export const InfSuffix = ".inf";
export const NoInformation = Object.freeze({ load: 0, exec: 0, locked: false });

const LockedFlag = /^l(ocked)?$/i;
const AttributeToken = /^[0-9a-f]{1,2}$/i;

export const toBbcName = (hostName) => hostName.replaceAll(".", "/");
export const toHostName = (bbcName) => bbcName.replaceAll("/", ".");

/** @returns {{load: number, exec: number, locked: boolean}} what a `.inf` line says, with what it leaves out as 0. */
export function parseInf(text) {
    const [, load = "0", exec = "0", , ...rest] = text.trim().split(/\r?\n/)[0].split(/\s+/);
    const hexOrZero = (token) => (/^[0-9a-f]{1,8}$/i.test(token) ? parseInt(token, 16) >>> 0 : 0);
    const locked = rest.some(
        (token) =>
            LockedFlag.test(token) || (AttributeToken.test(token) && (parseInt(token, 16) & LockedAttribute) !== 0),
    );
    return { load: hexOrZero(load), exec: hexOrZero(exec), locked };
}

export function formatInf(name, { load, exec, locked, length }) {
    return `$.${name}  ${hexUpper(load, 8)} ${hexUpper(exec, 8)} ${hexUpper(length, 8)}${locked ? " L" : ""}\n`;
}

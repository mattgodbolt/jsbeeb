import { NumRomBanks, RomBankBytes } from "./6502.js";
import { byteChar } from "./hex.js";

/**
 * A view of memory the debugger can show instead of what the CPU has paged in: one sideways bank at &8000 to
 * &BFFF, or on a Master ANDY at &8000 to &8FFF, or main or shadow RAM at &3000 to &7FFF. Everywhere else it
 * reads as paged. A view is named by the one character that qualifies an address in Go to (8000`4, 4:8000).
 * @typedef {string} PagingView
 */

export const PagedView = "";
export const AndyView = "n";
export const ShadowView = "s";
export const MainView = "m";

export const SidewaysStart = 0x8000;
const SidewaysEnd = 0xc000;
const AndyEnd = 0x9000;
const ShadowStart = 0x3000;
const ShadowEnd = 0x8000;
// Where romSelect and writeAcccon (6502.js) map ANDY and LYNNE, the shadow RAM, in ramRomOs.
const AndyOffset = 0;
const LynneOffset = 0x8000;

const CopyrightPointerOffset = 7;
const TitleOffset = 9;
const Copyright = "(C)";

const ViewChar = "[0-9a-fA-FnNsSmM]";
const SuffixForm = new RegExp(`^(.+)\`(${ViewChar})$`);
const PrefixForm = new RegExp(`^(${ViewChar}):(.+)$`);

/** The banks ROMSEL can page in: all sixteen, or on a four-socket B the four its two bits reach. */
export function sidewaysBanks({ romSockets }) {
    return Array.from({ length: romSockets }, (_, i) => NumRomBanks - romSockets + i);
}

/** Throws unless `bank`, if given, is a sideways bank. */
export function requireBank(bank, model) {
    const banks = sidewaysBanks(model);
    if (bank !== undefined && !banks.includes(bank))
        throw new Error(`Bank ${bank} is not ${banks[0]} to ${banks[banks.length - 1]}`);
}

export const bankView = (bank) => bank.toString(16);

export const bankName = (bank) => bankView(bank).toUpperCase();

/** @returns {number | undefined} the sideways bank `view` shows, if it shows one */
export function viewedBank(view) {
    return /^[0-9a-f]$/.test(view) ? parseInt(view, 16) : undefined;
}

/** Every view `model` has, the paged one first. */
export function viewsFor(model) {
    if (model.isAtom) return [PagedView];
    const views = [PagedView, ...sidewaysBanks(model).map(bankView)];
    if (model.isMaster) views.push(AndyView, MainView, ShadowView);
    return views;
}

/**
 * Splits a Go to text into the address it names and the view it qualifies it with, if any: 8000`4 or 4:8000 for
 * bank 4, and n, s and m for ANDY, shadow and main RAM. Undefined when it names a view `model` doesn't have.
 * @returns {{address: string, view: PagingView | undefined} | undefined}
 */
export function parseViewedAddress(text, model) {
    const suffixed = SuffixForm.exec(text);
    const prefixed = PrefixForm.exec(text);
    const [address, qualifier] = suffixed
        ? [suffixed[1], suffixed[2]]
        : prefixed
          ? [prefixed[2], prefixed[1]]
          : [text, undefined];
    if (qualifier === undefined) return { address, view: undefined };
    const view = qualifier.toLowerCase();
    return viewsFor(model).includes(view) && view !== PagedView ? { address: address.trim(), view } : undefined;
}

/** Where in `cpu.ramRomOs` `view` reads `address`, or undefined where it reads as paged. */
function viewedOffset(cpu, view, address) {
    const inside = (start, end) => address >= start && address < end;
    switch (view) {
        case PagedView:
            return undefined;
        case AndyView:
            return inside(SidewaysStart, AndyEnd) ? AndyOffset + address : undefined;
        case ShadowView:
            return inside(ShadowStart, ShadowEnd) ? LynneOffset + address : undefined;
        case MainView:
            return inside(ShadowStart, ShadowEnd) ? address : undefined;
        default:
            return inside(SidewaysStart, SidewaysEnd)
                ? cpu.romOffset + viewedBank(view) * RomBankBytes + address - SidewaysStart
                : undefined;
    }
}

/** The byte at `address` as `view` shows it, read as peekmem reads, without side effects. */
export function peekViewed(cpu, view, address) {
    address &= 0xffff;
    const offset = viewedOffset(cpu, view, address);
    return offset === undefined ? cpu.peekmem(address) : cpu.ramRomOs[offset];
}

/** Whether `view` shows something at `address` other than what the CPU would read there now. */
export function viewDiffers(cpu, view, address) {
    address &= 0xffff;
    const offset = viewedOffset(cpu, view, address);
    if (offset === undefined) return false;
    return cpu.memLook[cpu.memStatOffset + (address >>> 8)] + address !== offset;
}

function text(peek, from, to) {
    let read = "";
    for (let address = from; address < to; ++address) read += byteChar(peek(address));
    return read;
}

function zeroAt(peek, from, to) {
    for (let address = from; address < to; ++address) if (peek(address) === 0) return address;
    return undefined;
}

/**
 * The title and version string in the header of the sideways ROM `peek` reads at &8000, unprintable bytes shown as
 * dots, or undefined if there is no ROM there: no copyright string where the header points to one.
 * @param {(address: number) => number} peek
 * @returns {{title: string, version: string} | undefined}
 */
function romHeader(peek) {
    const copyright = SidewaysStart + peek(SidewaysStart + CopyrightPointerOffset);
    const titleStart = SidewaysStart + TitleOffset;
    if (copyright <= titleStart || peek(copyright) !== 0) return undefined;
    if (text(peek, copyright + 1, copyright + 1 + Copyright.length) !== Copyright) return undefined;
    const titleEnd = zeroAt(peek, titleStart, copyright) ?? copyright;
    const version = titleEnd < copyright ? text(peek, titleEnd + 1, copyright) : "";
    return { title: text(peek, titleStart, titleEnd), version };
}

/** What is in sideways `bank`: its ROM's title and version, or what it is with no ROM there. */
export function describeBank(cpu, bank) {
    const header = romHeader((address) => peekViewed(cpu, bankView(bank), address));
    if (header) return header.version ? `${header.title} ${header.version}` : header.title;
    return cpu.model.swram[bank] ? "sideways RAM" : "empty";
}

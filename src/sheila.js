import { hexword } from "./hex.js";
import { NoiseAwareIntelFdc } from "./intel-fdc.js";
import { NoiseAwareWdFdc } from "./wd-fdc.js";

/**
 * Which chip answers where in SHEILA (&FE00-&FEFF) on each BBC model, and what its registers are called, read
 * and written. The ranges follow the hardware's address decoding, even where jsbeeb's leaves a mirror out.
 *
 * @typedef {object} SheilaRegister
 * @property {string | undefined} read - undefined where the chip doesn't answer a read
 * @property {string | undefined} write - undefined where the chip doesn't take a write
 *
 * @typedef {object} SheilaBlock
 * @property {string} device - short, to prefix a register's name: "SysVIA"
 * @property {string} title - "System VIA"
 * @property {number} start
 * @property {number} end - exclusive
 * @property {SheilaRegister[]} registers - by offset from `start`, repeating up to `end`
 *
 * @typedef {object} SheilaFittings
 * @property {import("./models.js").Model} model
 * @property {boolean} hasTube
 * @property {boolean} hasEconet
 * @property {boolean} hasVideoNula
 *
 * @typedef {{block: SheilaBlock, name: string}} SheilaName
 */

const both = (name) => ({ read: name, write: name });
const readOnly = (name) => ({ read: name, write: undefined });
const writeOnly = (name) => ({ read: undefined, write: name });
const readWrite = (read, write) => ({ read, write });
const Unanswered = { read: undefined, write: undefined };

const block = (device, title, start, end, registers) => ({ device, title, start, end, registers });

const ViaRegisters = [
    readWrite("IRB", "ORB"),
    readWrite("IRA", "ORA"),
    both("DDRB"),
    both("DDRA"),
    readWrite("T1CL", "T1LL"),
    both("T1CH"),
    both("T1LL"),
    both("T1LH"),
    readWrite("T2CL", "T2LL"),
    both("T2CH"),
    both("SR"),
    both("ACR"),
    both("PCR"),
    both("IFR"),
    both("IER"),
    readWrite("IRA_NH", "ORA_NH"),
];

const Intel8271Registers = [
    readWrite("STATUS", "COMMAND"),
    readWrite("RESULT", "PARAMETER"),
    readWrite("COUNT_HI", "RESET"),
    readOnly("COUNT_LO"),
    both("DATA"),
    both("DATA"),
    both("DATA"),
    both("DATA"),
];

const Wd1770Registers = [
    writeOnly("CONTROL"),
    writeOnly("CONTROL"),
    writeOnly("CONTROL"),
    writeOnly("CONTROL"),
    readWrite("STATUS", "COMMAND"),
    both("TRACK"),
    both("SECTOR"),
    both("DATA"),
];

const DiscControllers = new Map([
    [NoiseAwareIntelFdc, { title: "8271 disc controller", registers: Intel8271Registers }],
    [NoiseAwareWdFdc, { title: "1770 disc controller", registers: Wd1770Registers }],
]);

const AdcRegisters = [readWrite("STATUS", "START"), readOnly("HIGH"), readOnly("LOW"), Unanswered];

// Register 1 is CR3 and register 3 CR4 when CR1's address control bit is set.
const AdlcRegisters = [
    readWrite("SR1", "CR1"),
    readWrite("SR2", "CR2"),
    readWrite("RXDATA", "TXDATA"),
    readWrite("RXDATA", "TXLAST"),
];

const TubeRegisters = [
    readWrite("R1STAT", "CONTROL"),
    both("R1"),
    readOnly("R2STAT"),
    both("R2"),
    readOnly("R3STAT"),
    both("R3"),
    readOnly("R4STAT"),
    both("R4"),
];

/**
 * The blocks of SHEILA on the machine `fittings` describe, none on an Atom, which has no SHEILA. A block answers
 * only some of its addresses in each direction, and at most one block answers each address in each direction.
 * @param {SheilaFittings} fittings
 * @returns {SheilaBlock[]}
 */
export function sheilaBlocks({ model, hasTube, hasEconet, hasVideoNula }) {
    if (model.isAtom) return [];
    const disc = DiscControllers.get(model.Fdc);
    const videoUla = [writeOnly("CONTROL"), writeOnly("PALETTE")];
    if (hasVideoNula) videoUla.push(writeOnly("NULA_CONTROL"), writeOnly("NULA_PALETTE"));
    const blocks = [
        block("CRTC", "6845 CRTC", 0xfe00, 0xfe08, [both("ADDR"), both("DATA")]),
        block("ACIA", "6850 ACIA", 0xfe08, 0xfe10, [readWrite("STATUS", "CONTROL"), both("DATA")]),
        block("SerialULA", "Serial ULA", 0xfe10, 0xfe18, [writeOnly("CONTROL")]),
        block("SysVIA", "System VIA", 0xfe40, 0xfe60, ViaRegisters),
        block("UserVIA", "User VIA", 0xfe60, 0xfe80, ViaRegisters),
    ];
    if (model.isMaster) {
        blocks.push(
            block("ADC", "7002 ADC", 0xfe18, 0xfe1c, AdcRegisters),
            block("VideoULA", "Video ULA", 0xfe20, 0xfe24, videoUla),
            block("FDC", disc.title, 0xfe24, 0xfe2c, disc.registers),
            block("Paging", "ROM select", 0xfe30, 0xfe34, [both("ROMSEL")]),
            block("Paging", "Access control", 0xfe34, 0xfe38, [both("ACCCON")]),
        );
        if (hasEconet)
            blocks.push(
                block("Econet", "Econet station and interrupt off", 0xfe38, 0xfe3c, [both("INTOFF")]),
                block("Econet", "Econet interrupt on", 0xfe3c, 0xfe40, [readOnly("INTON")]),
            );
    } else {
        blocks.push(
            block("VideoULA", "Video ULA", 0xfe20, 0xfe30, videoUla),
            block("Paging", "ROM select", 0xfe30, 0xfe40, [writeOnly("ROMSEL")]),
            block("FDC", disc.title, 0xfe80, 0xfea0, disc.registers),
            block("ADC", "7002 ADC", 0xfec0, 0xfee0, AdcRegisters),
        );
        if (hasEconet)
            blocks.push(
                block("Econet", "Econet station and interrupt off", 0xfe18, 0xfe20, [both("INTOFF")]),
                block("Econet", "Econet interrupt on", 0xfe20, 0xfe30, [readOnly("INTON")]),
            );
    }
    if (hasEconet) blocks.push(block("ADLC", "6854 ADLC", 0xfea0, 0xfec0, AdlcRegisters));
    if (hasTube) blocks.push(block("Tube", "Tube ULA", 0xfee0, 0xff00, TubeRegisters));
    return blocks.sort((a, b) => a.start - b.start);
}

/**
 * The register `address` reads or writes, by `access`.
 * @param {SheilaBlock[]} blocks
 * @param {number} address
 * @param {"read" | "write"} access
 * @returns {SheilaName | undefined}
 */
export function sheilaRegister(blocks, address, access) {
    for (const block of blocks) {
        if (address < block.start || address >= block.end) continue;
        const name = block.registers[(address - block.start) % block.registers.length][access];
        if (name !== undefined) return { block, name };
    }
    return undefined;
}

/**
 * What an instruction accessing `address` the ways `accesses` lists touches, named once per chip: a read-modify-write
 * of a VIA's ORB is "SysVIA.IRB/ORB".
 * @param {SheilaBlock[]} blocks
 * @param {number} address
 * @param {("read" | "write")[]} accesses
 * @returns {{name: string, title: string} | undefined}
 */
export function sheilaName(blocks, address, accesses) {
    const byBlock = new Map();
    for (const access of accesses) {
        const found = sheilaRegister(blocks, address, access);
        if (!found) continue;
        if (!byBlock.has(found.block)) byBlock.set(found.block, new Set());
        byBlock.get(found.block).add(found.name);
    }
    if (!byBlock.size) return undefined;
    const each = [...byBlock].map(([block, names]) => ({ block, names: [...names].join("/") }));
    return {
        name: each.map(({ block, names }) => `${block.device}.${names}`).join("/"),
        title: `${each.map(({ block, names }) => `${block.title} ${names}`).join(" / ")}: $${hexword(address)}`,
    };
}

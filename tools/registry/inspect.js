#!/usr/bin/env node
// Looks inside disc images for someone (or something) judging how two copies differ.
//
//   node tools/registry/inspect.js list <ref>
//   node tools/registry/inspect.js dump <ref> <file> [--text]
//   node tools/registry/inspect.js diff <ref> <file> <ref> <file>
//   node tools/registry/inspect.js dis <ref> <file> [<hex address> [<count>]]
//   node tools/registry/inspect.js basic <ref> <file>
//
// A ref is a path under the corpus (.registry-corpus by default, or --corpus), with
// `#member` for a file inside a zip; <file> is a DFS name such as $.ELITE.

import { Cpu6502 } from "../../src/6502.opcodes.js";
import { dfsCatalogue } from "./dfs.js";
import { loadRef } from "./diff-images.js";
import { imageSides, SectorSize } from "./fingerprint.js";

// BBC BASIC's keyword tokens, from &80.
const Tokens = (
    "AND DIV EOR MOD OR ERROR LINE OFF STEP SPC TAB( ELSE THEN _ OPENIN PTR PAGE TIME LOMEM HIMEM ABS ACS " +
    "ADVAL ASC ASN ATN BGET COS COUNT DEG ERL ERR EVAL EXP EXT FALSE FN GET INKEY INSTR( INT LEN LN LOG NOT " +
    "OPENUP OPENOUT PI POINT( POS RAD RND SGN SIN SQR TAN TO TRUE USR VAL VPOS CHR$ GET$ INKEY$ LEFT$( MID$( " +
    "RIGHT$( STR$ STRING$( EOF AUTO DELETE LOAD LIST NEW OLD RENUMBER SAVE EDIT PTR PAGE TIME LOMEM HIMEM " +
    "SOUND BPUT CALL CHAIN CLEAR CLOSE CLG CLS DATA DEF DIM DRAW END ENDPROC ENVELOPE FOR GOSUB GOTO GCOL IF " +
    "INPUT LET LOCAL MODE MOVE NEXT ON VDU PLOT PRINT PROC READ REM REPEAT REPORT RESTORE RETURN RUN STOP " +
    "COLOUR TRACE UNTIL WIDTH OSCLI"
).split(" ");
const LineNumberToken = 0x8d;
const [RemToken, DataToken] = [0xf4, 0xdc];
const hex = (value, width = 4) => value.toString(16).toUpperCase().padStart(width, "0");

async function files(corpus, ref) {
    const quiet = console.log;
    console.log = () => {};
    const { name, bytes } = await loadRef(corpus, ref);
    const { sides, addressed } = imageSides(name, bytes);
    console.log = quiet;
    return (addressed ?? sides).flatMap((side, index) => {
        const catalogue = dfsCatalogue(side);
        return (catalogue?.files ?? []).map((file) => ({
            ...file,
            side: index,
            title: catalogue.title,
            data: side.subarray(file.start * SectorSize, file.start * SectorSize + file.length),
        }));
    });
}

async function file(corpus, ref, name) {
    const found = (await files(corpus, ref)).find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!found) throw new Error(`No ${name} on ${ref}`);
    return found;
}

function hexDump(data, base) {
    const lines = [];
    for (let offset = 0; offset < data.length; offset += 16) {
        const row = data.subarray(offset, offset + 16);
        const text = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
        lines.push(
            `${hex(base + offset, 5)}  ${[...row]
                .map((b) => hex(b, 2))
                .join(" ")
                .padEnd(48)} ${text}`,
        );
    }
    return lines.join("\n");
}

function detokenise(data) {
    const lines = [];
    let offset = 0;
    while (offset + 3 < data.length && data[offset] === 0x0d && data[offset + 1] !== 0xff) {
        const number = (data[offset + 1] << 8) | data[offset + 2];
        const end = offset + data[offset + 3];
        let text = "";
        let literal = false;
        let quoted = false;
        for (let i = offset + 4; i < end && i < data.length; ++i) {
            const byte = data[i];
            if (byte === 0x22) quoted = !quoted;
            if (literal || quoted || byte < 0x80) text += byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".";
            else if (byte === LineNumberToken) {
                const [a, b, c] = data.subarray(i + 1, i + 4);
                text += (((a << 2) & 0xc0) ^ b) | ((((a << 4) & 0xc0) ^ c) << 8);
                i += 3;
            } else {
                text += Tokens[byte - 0x80];
                if (byte === RemToken || byte === DataToken) literal = true;
            }
        }
        lines.push(`${String(number).padStart(5)} ${text}`);
        if (end <= offset) break;
        offset = end;
    }
    return lines.join("\n");
}

async function main() {
    const args = process.argv.slice(2);
    const corpusIndex = args.indexOf("--corpus");
    const corpus = corpusIndex >= 0 ? args.splice(corpusIndex, 2)[1] : ".registry-corpus";
    const text = args.includes("--text");
    const [command, ...rest] = args.filter((a) => a !== "--text");
    switch (command) {
        case "list":
            for (const f of await files(corpus, rest[0]))
                console.log(
                    `side ${f.side} ${f.name.padEnd(10)} load ${hex(f.load, 6)} exec ${hex(f.exec, 6)} ` +
                        `length ${String(f.length).padStart(6)} sector ${String(f.start).padStart(3)} ${f.hash.slice(0, 8)}`,
                );
            break;
        case "dump": {
            const f = await file(corpus, rest[0], rest[1]);
            console.log(
                text
                    ? (String.fromCharCode(...f.data).match(/[ -~]{4,}/g) ?? []).join("\n")
                    : hexDump(f.data, f.load & 0xffff),
            );
            break;
        }
        case "diff": {
            const [a, b] = [await file(corpus, rest[0], rest[1]), await file(corpus, rest[2], rest[3])];
            console.log(`lengths ${a.length} and ${b.length}, load ${hex(a.load, 6)} and ${hex(b.load, 6)}`);
            let differing = 0;
            for (let i = 0; i < Math.max(a.data.length, b.data.length);) {
                if (a.data[i] === b.data[i]) {
                    ++i;
                    continue;
                }
                let j = i;
                while (j < Math.max(a.data.length, b.data.length) && a.data[j] !== b.data[j]) ++j;
                differing += j - i;
                const show = (d) => [...d.subarray(i, Math.min(j, i + 16))].map((x) => hex(x, 2)).join(" ");
                console.log(
                    `offset ${hex(i)} (address ${hex((a.load + i) & 0xffff)}), ${j - i} bytes: ${show(a.data)} | ${show(b.data)}`,
                );
                i = j;
            }
            console.log(`${differing} bytes differ`);
            break;
        }
        case "dis": {
            const f = await file(corpus, rest[0], rest[1]);
            const base = f.load & 0xffff;
            const { disassembler } = Cpu6502({ peekmem: (address) => f.data[address - base] ?? 0 });
            let address = rest[2] ? parseInt(rest[2], 16) : base;
            for (let n = 0; n < Number(rest[3] ?? 32) && address < base + f.length; ++n) {
                const [instruction, next] = disassembler.disassemble(address, true);
                console.log(`${hex(address)}  ${instruction}`);
                address = next;
            }
            break;
        }
        case "basic":
            console.log(detokenise((await file(corpus, rest[0], rest[1])).data));
            break;
        default:
            throw new Error("Commands: list, dump, diff, dis, basic");
    }
}

main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
});

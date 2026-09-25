import { describe, expect, it } from "vitest";
import {
    anchorCandidates,
    buildSymbolSet,
    bytesToHex,
    checkRegion,
    chooseAnchors,
    evaluate,
    parsePy8disListing,
    storeTargets,
} from "../../tools/registry/anchors.js";

const Listing = `counter = $70
oswrch = $ffee

    * = $2000
// Referenced 2 times by $3000, $3010
entry:
    lda #$01                                                // 2000: a9 01
    sta patched+1                                           // 2002: 8d 09 20
    jsr helper                                              // 2005: 20 0d 20
patched:
    lda #$00 // '/'                                         // 2008: a9 00
    jmp oswrch                                              // 200a: 4c ee ff
helper:
    ldx #$05                                                // 200d: a2 05
    stx counter                                             // 200f: 86 70
    lda table,x                                             // 2011: bd 16 20
    rts                                                     // 2014: 60
    .byt $ea                                                // 2015: .
table:
    .byt $01, <(helper), "AB"                               // 2016: ..AB
`;

const region = { start: 0x2000, end: 0x201a };

function memoryOf(listing) {
    const memory = new Uint8Array(0x10000);
    for (const [addr, value] of listing.bytes) memory[addr] = value;
    return memory;
}

describe("registry anchors", () => {
    const listing = parsePy8disListing(Listing);
    const { written } = storeTargets(listing);

    it("evaluates py8dis operand expressions", () => {
        const symbols = new Map([["helper", 0x200d]]);
        expect(evaluate("helper+1", symbols)).toBe(0x200e);
        expect(evaluate(">(helper)", symbols)).toBe(0x20);
        expect(evaluate("$ff-1", symbols)).toBe(0xfe);
    });

    it("reads instruction bytes from the listing's comments and data bytes from its operands", () => {
        expect(listing.sections).toEqual([region]);
        expect(listing.labels.get("helper")).toBe(0x200d);
        expect(listing.references.get(0x2000)).toBe(2);
        expect([0x2016, 0x2017, 0x2018, 0x2019].map((a) => listing.bytes.get(a))).toEqual([0x01, 0x0d, 0x41, 0x42]);
    });

    it("treats a store's operand, including a self-modified one, as written", () => {
        expect(written.has(0x2009)).toBe(true);
        expect(written.has(0x70)).toBe(true);
        expect(written.has(0x2008)).toBe(false);
    });

    it("never starts or extends an anchor over a byte the code writes", () => {
        const candidates = anchorCandidates(listing, region, written);
        expect(candidates.map((c) => [c.at, bytesToHex(c.bytes), c.pinned])).toEqual([
            [0x2000, "a9018d0920200d20", true],
            [0x200d, "a2058670bd162060", true],
        ]);
        const unfiltered = anchorCandidates(listing, region, written, { respectWrites: false });
        expect(unfiltered.map((c) => c.at)).toContain(0x2008);
    });

    it("spreads the chosen anchors over the code", () => {
        const candidates = anchorCandidates(listing, region, written);
        expect(chooseAnchors(candidates, 1).map((c) => c.at)).toEqual([0x2000]);
        expect(chooseAnchors(candidates, 2).map((c) => c.at)).toEqual([0x2000, 0x200d]);
    });

    describe("checking a region against memory", () => {
        const { set } = buildSymbolSet(listing, { name: "test", perKb: 100, maxAnchors: 2 });
        const built = set.test.regions.r2000;

        it("matches the listing's own bytes, and still matches after the code modifies itself", () => {
            const memory = memoryOf(listing);
            expect(checkRegion(built, (a) => memory[a]).matched).toBe(true);
            memory[0x2009] = 0x42;
            expect(checkRegion(built, (a) => memory[a]).matched).toBe(true);
        });

        it("withholds labels when the code has moved", () => {
            const memory = memoryOf(listing);
            memory.copyWithin(0x2001, 0x2000, 0x201a);
            memory[0x2000] = 0xea;
            expect(checkRegion(built, (a) => memory[a])).toEqual({ matched: false, results: [false, false] });
        });

        it("withholds labels before anything has loaded", () => {
            expect(checkRegion(built, () => 0).matched).toBe(false);
        });
    });
});

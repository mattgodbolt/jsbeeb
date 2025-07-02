import { describe, it, expect } from "vitest";
import * as Tokeniser from "../../src/basic-tokenise.js";
const tokeniser = Tokeniser.create();

describe("Tokeniser", function () {
    "use strict";

    async function check(text, expected) {
        try {
            const t = await tokeniser;
            expect(t.tokenise(text)).toBe(expected);
        } catch (e) {
            console.log("Failed:", e);
            expect(e).toBe("");
        }
    }

    async function checkThrows(text, expectedError) {
        try {
            const t = await tokeniser;
            t.tokenise(text);
            console.log("Failed to give exception with message:", expectedError);
            expect.fail("Expected an exception to be thrown");
        } catch (e) {
            expect(e.message).toBe(expectedError);
        }
    }

    it("handles a simple program", async function () {
        await check(
            '10 PRINT "hello"\n20 GOTO 10\n',
            '\r\x00\x0a\x0e \xf1 "hello"\r\x00\x14\x0b \xe5 \x8d\x54\x4a\x40\r\xff',
        );
    });
    it("handles assignment to HIMEM", async function () {
        await check("HIMEM=&6000", "\r\x00\x0a\x0b\xd3=&6000\r\xff");
    });
    it("handles reading from HIMEM", async function () {
        await check("PRINT HIMEM", "\r\x00\x0a\x07\xf1 \x93\r\xff");
    });
    it("deals with colons", async function () {
        await check("PRINT HIMEM:HIMEM=&6000", "\r\x00\x0a\x0f\xf1 \x93:\xd3=&6000\r\xff");
    });
    it("handles MODE", async function () {
        await check("IF0ELSEMODE0", "\r\x00\x0a\x09\xe70\x8b\xeb0\r\xff");
    });
    it("handles a snippet from one line Tetris", async function () {
        await check(
            "d=d:IFd VDUd:p=POINT(64*POS,1E3-VPOS*32):RETURN ELSEMODE2:GCOL0,-9:CLG",
            "\r\x00\x0a\x2dd=d:\xe7d \xefd:p=\xb064*\xb1,1E3-\xbc*32):\xf8 \x8b\xeb2:\xe60,-9:\xda\r\xff",
        );
    });
    it("copes with token names inside strings", async function () {
        await check('PRINT "IF ""IF"" IF"', '\r\x00\x0a\x14\xf1 "IF ""IF"" IF"\r\xff');
    });
    it("handles REM", async function () {
        await check("10REM I am a monkey", "\r\x00\x0a\x13\xf4 I am a monkey\r\xff");
    });
    it("handles extra long input", async function () {
        await check("10" + "ENVELOPE".repeat(251), "\r\x00\x0a\xff" + "\xe2".repeat(251) + "\r\xff");
    });
    it("gives error for overlong input", async function () {
        await checkThrows("10" + "ENVELOPE".repeat(252), "Line 10 tokenised length 252 > 251 bytes");
    });
});

import { describe, expect, it } from "vitest";
import { RomBankBytes } from "../../src/6502.js";
import { TestMachine } from "../../src/test-machine.js";
import { Video } from "../../src/video.js";
import { bootedTestMachine, screenLines } from "./helpers.js";

const FramebufferPixels = 1024 * 1024;
const Romsel = 0xfe30;
const SidewaysStart = 0x8000;
const EmptyBank = 8;
const RomByte = 0xa5;

// Tom Seddon's FLOAT, from https://github.com/mattgodbolt/jsbeeb/issues/1888, with its results on his Master 128.
const Float = `
30 DIM C% 200,B% 64,H%(255),S$(3)
40 FOR I%=0 TO 2 STEP 2:P%=C%
50 [OPT I%
60 .rd SEI:LDA &F4:PHA:LDA #8:STA &F4:STA &FE30:LDX #63
70 .l LDA &8008:STA B%,X:DEX:BPL l
80 PLA:STA &F4:STA &FE30:CLI:RTS
90 ]:NEXT
100 FOR R%=0 TO 3
110 M%=7-6*(R% DIV 2):V%=&41+&19*(R% MOD 2)
120 MODE M%:VDU 23,1,0;0;0;0;
130 IF M%=7 S%=&7C00 ELSE S%=&3000
140 FOR A%=S% TO &7FFC STEP 4:!A%=V%*&1010101:NEXT
150 CALL rd
160 FOR I%=0 TO 255:H%(I%)=0:NEXT
170 FOR I%=0 TO 63:H%(B%?I%)=H%(B%?I%)+1:NEXT
180 S$(R%)="MODE "+STR$M%+", screen &"+STR$~V%+": "
190 FOR I%=0 TO 255:IF H%(I%) S$(R%)=S$(R%)+"&"+STR$~I%+"x"+STR$H%(I%)+" "
200 NEXT
210 NEXT
220 MODE 7
230 PRINT "Bank 8 in the ROM table: &";~?&2A9
240 FOR R%=0 TO 3:PRINT S$(R%):NEXT
`;

describe("Master hardware", () => {
    it("reads the byte the video fetches from an empty sideways socket", async () => {
        const video = new Video(true, FramebufferPixels, () => {});
        const machine = await bootedTestMachine("Master", { video }, 10);
        await machine.loadBasic(Float);
        await machine.type("RUN");
        await machine.runUntilInput(30);
        expect(screenLines(machine).slice(0, 5)).toEqual([
            "Bank 8 in the ROM table: &0",
            "MODE 7, screen &41: &41x64",
            "MODE 7, screen &5A: &5Ax64",
            "MODE 1, screen &41: &41x64",
            "MODE 1, screen &5A: &5Ax64",
        ]);
    });

    it("reads a ROM put in the empty socket, and in a fresh Master restored from a snapshot of it", async () => {
        const newMaster = async () => {
            const machine = new TestMachine("Master", { video: new Video(true, FramebufferPixels, () => {}) });
            await machine.initialise();
            return machine;
        };
        const readBank8 = (machine) => {
            machine.writebyte(Romsel, EmptyBank);
            return machine.readbyte(SidewaysStart + 8);
        };
        const withRom = await newMaster();
        withRom.loadSidewaysRam(EmptyBank, new Uint8Array(RomBankBytes).fill(RomByte));
        const restored = await newMaster();
        restored.restore(withRom.snapshot());
        expect([readBank8(withRom), readBank8(restored)]).toEqual([RomByte, RomByte]);
    });
});

import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";
import { load } from "../../src/fdc.js";

const SectorSize = 256;
const SectorsPerTrack = 10;
const FortyTrackSectors = 40 * SectorsPerTrack;

/**
 * An image of a 40 track disc holding one file, put as far from the catalogue as the disc reaches
 * so that reading it takes the head all the way out.
 */
function fortyTrackImage(name, fileSector, fill) {
    const data = new Uint8Array(FortyTrackSectors * SectorSize);
    const ascii = (text) => new TextEncoder().encode(text);
    data.set(ascii("40TRACK "), 0);
    data.set(ascii(name), 0x008);
    data[0x00f] = "$".charCodeAt(0);
    data.set(ascii("DISC"), 0x100);
    data[0x105] = 1 * 8;
    data[0x106] = (FortyTrackSectors >>> 8) & 3;
    data[0x107] = FortyTrackSectors & 0xff;
    // One sector, loading and running at &3000.
    data[0x109] = 0x30;
    data[0x10b] = 0x30;
    data[0x10d] = SectorSize >>> 8;
    data[0x10e] = (fileSector >>> 8) & 3;
    data[0x10f] = fileSector & 0xff;
    data.fill(fill, fileSector * SectorSize, (fileSector + 1) * SectorSize);
    return data;
}

describe("disc track layouts", { timeout: 60000 }, function () {
    async function machineWith(image) {
        const testMachine = new TestMachine();
        await testMachine.initialise();
        testMachine.loadDiscData(image);
        await testMachine.runUntilInput();
        const seen = [];
        testMachine.captureText((element) => seen.push(element.text));
        return { testMachine, seen };
    }

    it("takes the head to the far side of the surface for the last track of a 40 track disc", async () => {
        const fill = 0xa5;
        const { testMachine, seen } = await machineWith(fortyTrackImage("FARAWAY", FortyTrackSectors - 1, fill));

        await testMachine.type("*LOAD FARAWAY 3000");
        await testMachine.runUntilInput();
        await testMachine.type("PRINT ?&3000");
        await testMachine.runUntilInput();

        expect(seen.at(-1).trim()).toBe(`${fill}`);
        // DFS asked for its track 39, which a 40 track format keeps on the 78th track of the surface.
        expect(testMachine.processor.fdc.drives[0].track).toBe(78);
    });

    it("leaves an 80 track disc where it has always been", async () => {
        const { testMachine, seen } = await machineWith(await load("discs/Welcome.ssd"));

        await testMachine.type("*CAT");
        await testMachine.runUntilInput();

        expect(seen.join("\n")).toContain("WELCOME-DISK");
        expect(testMachine.processor.fdc.drives[0].disc.is40Track).toBe(false);
    });
});

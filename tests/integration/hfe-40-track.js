import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";
import { discFor, load } from "../../src/fdc.js";

/**
 * elite.hfe holds a 40 track disc as an 80 track drive sees it, on every other track of the
 * surface. Its catalogue is on track 0 and reads either way; everything else needs the drive to
 * step twice for each track DFS asks for.
 */
describe("a 40 track disc captured in an 80 track drive", { timeout: 120000 }, function () {
    it("reads a file that lives past its catalogue", async () => {
        const testMachine = new TestMachine();
        await testMachine.initialise();
        const image = await load("discs/elite.hfe");
        testMachine.processor.fdc.loadDisc(0, discFor(testMachine.processor.fdc, "elite.hfe", image));
        await testMachine.runUntilInput();
        const seen = [];
        testMachine.captureText((element) => seen.push(element.text));

        // D.MOP is DFS track 36, which a 40 track format keeps on the 72nd track of the surface.
        await testMachine.type("*LOAD D.MOP 3000");
        await testMachine.runUntilInput(20);

        expect(seen.join("\n")).not.toContain("fault");
        expect(testMachine.processor.fdc.drives[0].tracksPerStep).toBe(2);
        expect(testMachine.processor.fdc.drives[0].track).toBeGreaterThan(70);
    });
});

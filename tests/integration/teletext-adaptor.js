import { describe, it, expect } from "vitest";
import { TestMachine } from "../test-machine.js";

const TeletextStatusRegister = 0xfc10;
// INT, DOR and FSYN, all latched by the adaptor once a frame of broadcast data is ready.
const TeletextStatusDataReady = 0xd0;

describe("Teletext adaptor", () => {
    it("receives broadcast data as the machine runs", async () => {
        const machine = new TestMachine("B-DFS1.2", { hasTeletextAdaptor: true });
        await machine.initialise();
        expect(machine.readbyte(TeletextStatusRegister) & TeletextStatusDataReady).toBe(0);

        await machine.runFor(2 * 1000 * 1000);

        expect(machine.readbyte(TeletextStatusRegister) & TeletextStatusDataReady).toBe(TeletextStatusDataReady);
        expect(machine.processor.teletextAdaptor.currentFrame).toBeGreaterThan(1);
    });

    it("leaves the adaptor absent when not fitted", async () => {
        const machine = new TestMachine("B-DFS1.2");
        await machine.initialise();

        await machine.runFor(2 * 1000 * 1000);

        expect(machine.processor.hasTeletextAdaptor).toBe(false);
        expect(machine.readbyte(TeletextStatusRegister)).toBe(0xff);
    });
});

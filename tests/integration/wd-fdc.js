import { describe, it, expect } from "vitest";

import { bootedTestMachine, mode7Text } from "./helpers.js";

const ResultRow = 22;
const Mode7Columns = 40;
const PollCycles = 1_000_000;
const MaxPolls = 10;

describe("WD1770", () => {
    it("ends READ ADDRESS before a chained-NMI driver can read the status (#1850)", async () => {
        const machine = await bootedTestMachine("Master");
        await machine.loadDisc("discs/rdaddr-race.ssd");
        await machine.type("*RUN !BOOT");
        const resultLine = () =>
            mode7Text(machine)
                .slice(ResultRow * Mode7Columns, (ResultRow + 1) * Mode7Columns)
                .trim();
        for (let poll = 0; poll < MaxPolls && !resultLine().startsWith("RESULT:"); poll++) {
            await machine.runFor(PollCycles);
        }
        expect(
            resultLine(),
            "rdaddr-race.ssd hangs on a real Master: INTRQ must follow READ ADDRESS's last DRQ closely (#1850)",
        ).toMatch(/^RESULT: HANG after 00000/);
    });
});

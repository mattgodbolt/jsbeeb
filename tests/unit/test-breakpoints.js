import { beforeEach, describe, expect, it } from "vitest";

import { describeHit } from "../../src/breakpoints.js";
import { fake6502 } from "../../src/fake6502.js";

describe("Breakpoints", () => {
    const Start = 0x2000;
    const Store = 0x2002;
    const Load = 0x2005;
    const Jump = 0x2008;
    const Data = 0x3000;
    const Cleared = 0x00;
    // LDA #&41, STA &3000, LDX &3000, JMP &2000
    const Program = [0xa9, 0x41, 0x8d, 0x00, 0x30, 0xae, 0x00, 0x30, 0x4c, 0x00, 0x20];
    const Loaded = 0x41;
    const ManyLoops = 1000;

    let cpu;
    let breakpoints;
    let hits;

    beforeEach(async () => {
        cpu = fake6502();
        await cpu.initialise();
        Program.forEach((byte, i) => cpu.writemem(Start + i, byte));
        cpu.writemem(Data, Cleared);
        cpu.pc = Start;
        cpu.p.i = true;
        breakpoints = cpu.breakpoints;
        hits = [];
        breakpoints.onHit((hit) => hits.push(hit));
    });

    const run = () => cpu.execute(ManyLoops);

    it.each([
        ["execute", { kind: "execute", start: Load }, Load, { access: "execute", address: Load, pc: Load }],
        [
            "write",
            { kind: "write", start: Data },
            Load,
            { access: "write", address: Data, pc: Store, value: Loaded, old: Cleared },
        ],
        ["read", { kind: "read", start: Data }, Jump, { access: "read", address: Data, pc: Load, value: Loaded }],
        ["access", { kind: "access", start: Data }, Load, { access: "write", address: Data, pc: Store }],
        ["execute range", { kind: "execute", start: Store + 1, end: Jump }, Load, { address: Load }],
        ["reads of code", { kind: "read", start: Jump + 1 }, Start, { access: "read", address: Jump + 1, pc: Jump }],
    ])("a %s breakpoint stops the machine and says what hit it", (_, spec, stoppedAt, hit) => {
        const id = breakpoints.add(spec);
        expect(run()).toBe(false);
        expect(cpu.pc).toBe(stoppedAt);
        expect(hits).toEqual([expect.objectContaining({ id, action: "stop", hits: 1, ...hit })]);
    });

    it("needs the CPU's slower path only while an enabled breakpoint is set", () => {
        expect(cpu.onFastPath).toBe(true);
        const id = breakpoints.add({ kind: "write", start: Data, enabled: false });
        expect(cpu.onFastPath).toBe(true);
        breakpoints.update(id, { enabled: true });
        expect(cpu.onFastPath).toBe(false);
        breakpoints.remove(id);
        expect(cpu.onFastPath).toBe(true);
    });

    it("stops on the hit count's hit and every one after", () => {
        const id = breakpoints.add({ kind: "execute", start: Store, hitCount: 3 });
        expect(run()).toBe(false);
        expect(run()).toBe(false);
        expect(hits.map((hit) => hit.hits)).toEqual([3, 4]);
        expect(breakpoints.get(id).hits).toBe(4);
        breakpoints.resetHits();
        expect(breakpoints.get(id).hits).toBe(0);
    });

    it("stops only when its condition holds", () => {
        breakpoints.add({ kind: "execute", start: Start, condition: "X = &41" });
        expect(run()).toBe(false);
        expect(cpu.pc).toBe(Start);
        expect(cpu.x).toBe(Loaded);
    });

    it("gives a condition the address of the instruction making the access, as the hit does", () => {
        breakpoints.add({ kind: "write", start: Data, condition: "PC = &2002" });
        expect(run()).toBe(false);
        expect(hits).toEqual([expect.objectContaining({ pc: Store })]);
    });

    it("stops on a write to an I/O register", () => {
        const UserViaDdrb = 0xfe62;
        cpu.writemem(Store + 1, UserViaDdrb & 0xff);
        cpu.writemem(Store + 2, UserViaDdrb >> 8);
        breakpoints.add({ kind: "write", start: UserViaDdrb });
        expect(run()).toBe(false);
        expect(hits).toEqual([expect.objectContaining({ address: UserViaDdrb, value: Loaded, pc: Store })]);
    });

    it("stops on a write that changes the byte, with value != old", () => {
        breakpoints.add({ kind: "write", start: Data, condition: "value != old" });
        expect(run()).toBe(false);
        expect(run()).toBe(true);
        expect(hits).toHaveLength(1);
    });

    it("logs without stopping, calling its own onHit too", () => {
        const own = [];
        breakpoints.add({ kind: "execute", start: Store, action: "log", onHit: (hit) => own.push(hit) });
        expect(run()).toBe(true);
        expect(hits.length).toBeGreaterThan(1);
        expect(own).toEqual(hits);
        expect(describeHit(hits[0])).toBe("Breakpoint 1: execute $2002 at pc $2002, hit 1");
    });

    it("reports every breakpoint the stopping access hits", () => {
        const ids = [
            breakpoints.add({ kind: "write", start: Data }),
            breakpoints.add({ kind: "access", start: Data - 1, end: Data + 1, action: "log" }),
        ];
        expect(run()).toBe(false);
        expect(hits.map((hit) => hit.id)).toEqual(ids);
    });

    it("tells listeners of each change, and lists what is set", () => {
        let changes = 0;
        breakpoints.onChange(() => changes++);
        const id = breakpoints.add({ kind: "read", start: Data, condition: " A = 1 ", label: "flag" });
        breakpoints.update(id, { start: Load });
        expect(breakpoints.list()).toEqual([
            {
                id,
                kind: "read",
                start: Load,
                end: Load,
                bank: undefined,
                condition: "A = 1",
                hitCount: 1,
                enabled: true,
                action: "stop",
                label: "flag",
                owner: "user",
                onHit: undefined,
                hits: 0,
            },
        ]);
        breakpoints.clear();
        expect(breakpoints.list()).toEqual([]);
        expect(changes).toBe(3);
    });

    it.each([
        [{ kind: "jump", start: 0 }, "Unknown breakpoint type: jump"],
        [{ kind: "read", start: 0x10000 }, "Breakpoint start 65536 is not an address from 0 to $ffff"],
        [{ kind: "read", start: 2, end: 1 }, "Breakpoint end $0001 is before its start $0002"],
        [{ kind: "read", start: 0, bank: 16 }, "Bank 16 is not 0 to 15"],
        [{ kind: "read", start: 0, hitCount: 0 }, "Hit count 0 is not 1 or more"],
        [{ kind: "read", start: 0, action: "pause" }, "Breakpoint action pause is not stop or log"],
        [{ kind: "read", start: 0, condition: "A =" }, 'Bad condition "A =": expected a value at column 4'],
        [{ kind: "read", start: 0, condition: 5 }, "Breakpoint condition 5 is not text"],
        [{ kind: "read", start: 0, enabled: "false" }, "Breakpoint enabled false is not true or false"],
    ])("refuses %j", (spec, message) => {
        expect(() => breakpoints.add(spec)).toThrow(message);
        expect(breakpoints.list()).toEqual([]);
    });

    it("is not called once another hook in the same dispatch removes the last breakpoint", () => {
        let id;
        cpu.debugInstruction.add(() => {
            if (breakpoints.list().length) breakpoints.remove(id);
        });
        id = breakpoints.add({ kind: "execute", start: Store });
        expect(run()).toBe(true);
        expect(hits).toEqual([]);
    });

    it("refuses to change or remove a breakpoint that is not there", () => {
        expect(() => breakpoints.remove(7)).toThrow("No breakpoint with id 7");
        expect(() => breakpoints.update(7, {})).toThrow("No breakpoint with id 7");
    });
});

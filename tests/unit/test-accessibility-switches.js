import { describe, expect, it } from "vitest";

import { AccessibilitySwitches } from "../../src/web/accessibility-switches.js";

describe("AccessibilitySwitches", () => {
    it("reads as no switches pressed to begin with", () => {
        expect(new AccessibilitySwitches().userPort.read()).toBe(0xff);
    });

    it("clears a switch's bit while held and restores it on release", () => {
        const switches = new AccessibilitySwitches();
        switches.setSwitch(0, true);
        expect(switches.userPort.read()).toBe(0xfe);
        switches.setSwitch(7, true);
        expect(switches.userPort.read()).toBe(0x7e);
        switches.setSwitch(0, false);
        expect(switches.userPort.read()).toBe(0x7f);
        switches.setSwitch(7, false);
        expect(switches.userPort.read()).toBe(0xff);
    });

    it("ignores writes from the user port", () => {
        const switches = new AccessibilitySwitches();
        switches.userPort.write(0x00);
        expect(switches.userPort.read()).toBe(0xff);
    });
});

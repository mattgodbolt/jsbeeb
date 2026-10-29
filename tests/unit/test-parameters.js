// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    DisplaySection,
    matchesHost,
    Parameters,
    parameterFor,
    processInputParams,
    readTakenFromHost,
    takenFromHostValues,
    tubeCpuSpeedLabel,
    urlParamType,
} from "../../src/web/parameters.js";
import { configForm } from "../../src/web/config-form.js";
import { Settings } from "../../src/web/settings.js";
import { Config } from "../../src/web/config.js";
import { UrlState } from "../../src/web/url-state.js";
import { ParamTypes, parseQueryString } from "../../src/url-params.js";
import { MaxPersistenceMs, persistenceSettings } from "../../src/web/canvas.js";
import { findModel } from "../../src/models.js";
import { domFromIndexHtml, fakeUrlState, teardownDom } from "./helpers.js";

describe("Parameters", () => {
    afterEach(teardownDom);

    const families = Object.entries(Parameters).filter(([, { prefix }]) => prefix);
    const fixedNames = Object.keys(Parameters).filter((name) => !Parameters[name].prefix);

    it.each(Object.entries(Parameters))("declares a URL type for %s", (name, parameter) => {
        expect(Object.values(ParamTypes)).toContain(parameter.type);
    });

    it.each(families)("declares nothing for %s that only works by name", (name, family) => {
        for (const property of ["default", "stored", "field", "slid", "startupAction", "reportedAtStart"])
            expect(family, property).not.toHaveProperty(property);
    });

    it.each(families)("puts no parameter with a name of its own in %s", (name, { prefix, names = [] }) => {
        for (const fixed of fixedNames) {
            expect(fixed.toUpperCase().startsWith(prefix), fixed).toBe(false);
            expect(names, fixed).not.toContain(fixed);
        }
    });

    it.each(families)(
        "declares %s so that a URL name can match it, and no other family can",
        (name, { prefix, names = [] }) => {
            expect(prefix).toBe(prefix.toUpperCase());
            for (const [other, family] of families.filter(([otherName]) => otherName !== name)) {
                expect(family.prefix.startsWith(prefix) || prefix.startsWith(family.prefix), other).toBe(false);
                for (const member of names) expect(parameterFor(member).parameter, member).not.toBe(family);
            }
        },
    );

    it.each(Object.entries(Parameters).filter(([, { reportedAtStart }]) => reportedAtStart))(
        "reports %s at start only as one of a fixed set of values",
        (name, { type, field }) => {
            const urlState = new UrlState(
                { origin: "https://bbc.example", pathname: "/", search: `?${name}=SomeonesOwnText`, hash: "" },
                { pushState: vi.fn() },
            );
            vi.spyOn(console, "log").mockImplementation(() => {});
            const value = new Settings({ urlState }).value(name);
            if (type === ParamTypes.BOOL) expect(typeof value === "boolean" || value === undefined).toBe(true);
            else expect(field.options.map((option) => option.value)).toContain(value);
        },
    );

    it("never makes a startup action or a setting that needs a fresh machine local to the page", () => {
        for (const [name, parameter] of Object.entries(Parameters).filter(([, { localToPage }]) => localToPage)) {
            expect(parameter.field?.restart, name).toBeFalsy();
            expect(parameter.startupAction, name).toBeFalsy();
        }
    });

    it("declares each display's afterglow a remembered slider setting, kept within what a display can show", () => {
        for (const { setting, default: afterglowMs } of persistenceSettings()) {
            expect(Parameters[setting], setting).toMatchObject({
                type: ParamTypes.FLOAT,
                stored: true,
                slid: true,
                default: afterglowMs,
            });
            expect(Parameters[setting].fit(MaxPersistenceMs + 1)).toBe(MaxPersistenceMs);
        }
    });

    it("lays the dialog out in the order the parameters are declared, sections and group together", () => {
        const layout = configForm().map((entry) =>
            Array.isArray(entry)
                ? entry.map((field) => field.setting ?? field.id)
                : entry.type === "group"
                  ? { [entry.label]: entry.fields.map((field) => field.setting) }
                  : entry.setting,
        );
        expect(layout).toEqual([
            "model",
            "keyLayout",
            ["displayMode", "persistence"],
            {
                "Additional peripherals": [
                    "coProcessor",
                    "tubeCpuMultiplier",
                    "hasMusic5000",
                    "hasTeletextAdaptor",
                    "hasEconet",
                    "hasVideoNula",
                ],
            },
            ["audioOutput", "speakerAmount"],
            ["microphoneChannel"],
            ["mouseJoystickEnabled"],
            ["speechOutput"],
        ]);
    });

    describe("adding a setting takes its declaration alone", () => {
        const withMadeUpSetting = {
            ...Parameters,
            screenTint: {
                type: ParamTypes.STRING,
                stored: true,
                default: "amber",
                fromUrl: (tint) => tint.toLowerCase(),
                valid: (tint) => ["amber", "green"].includes(tint),
                field: {
                    type: "menu",
                    section: DisplaySection,
                    label: "Screen tint",
                    options: [
                        { value: "amber", text: "Amber" },
                        { value: "green", text: "Green" },
                    ],
                },
            },
            scanlines: { type: ParamTypes.BOOL, stored: true, default: true },
            tintLevel: { type: ParamTypes.INT, stored: true, default: 3 },
        };
        const urlStateFor = (search) =>
            new UrlState(
                { origin: "https://bbc.example", pathname: "/", search, hash: "" },
                { pushState: vi.fn() },
                (name) => urlParamType(name, withMadeUpSetting),
            );
        const settingsFor = (search) => new Settings({ urlState: urlStateFor(search), parameters: withMadeUpSetting });

        it("is read, with its default", () => {
            expect(settingsFor("").screenTint).toBe("amber");
            expect(settingsFor("?screenTint=green").screenTint).toBe("green");
        });

        it("is adjusted from the URL before it is checked", () => {
            expect(settingsFor("?screenTint=Green").screenTint).toBe("green");
            expect(settingsFor("?screenTint=Blue").screenTint).toBe("amber");
        });

        it("is stored and read back", () => {
            settingsFor("").set({ screenTint: "green" });
            expect(window.localStorage.screenTint).toBe("green");
            expect(settingsFor("").screenTint).toBe("green");
        });

        it("reads a stored checkbox and number back as what was stored, not the default", () => {
            settingsFor("").set({ scanlines: false, tintLevel: 5 });
            expect(window.localStorage.scanlines).toBe("false");
            expect(settingsFor("")).toMatchObject({ scanlines: false, tintLevel: 5 });
        });

        it("round-trips through the URL", () => {
            const settings = settingsFor("?model=Master");
            settings.set({ screenTint: "green" });
            expect(settings.urlState.url()).toBe("https://bbc.example/?model=Master&screenTint=green");
            expect(settingsFor(new URL(settings.urlState.url()).search).screenTint).toBe("green");
        });

        it("appears in the dialog where it is declared, and sets the setting", () => {
            domFromIndexHtml("configuration");
            const settings = settingsFor("?screenTint=green");
            new Config(settings);
            const layout = configForm(withMadeUpSetting).find(Array.isArray);
            expect(layout.map((field) => field.setting ?? field.id)).toEqual([
                "displayMode",
                "screenTint",
                "persistence",
            ]);
            expect(document.getElementById("screenTintDropdown").textContent.trim()).toBe("Green");
            document.querySelector('.screen-tint-menu a[data-value="amber"]').click();
            document.getElementById("configuration").dispatchEvent(new Event("hide.bs.modal"));
            expect(settings.screenTint).toBe("amber");
        });
    });
});

describe("parameterFor", () => {
    it.each([
        ["disc1", Parameters.disc1, undefined],
        ["KEY.CAPSLOCK", Parameters.keyMapping, "CAPSLOCK"],
        ["key.capslock", Parameters.keyMapping, "CAPSLOCK"],
        ["GP.FIRE2", Parameters.gamepadMapping, "FIRE2"],
        ["gp.fire2", Parameters.gamepadMapping, "FIRE2"],
        ["FIRE", Parameters.gamepadMapping, "FIRE"],
        ["rom", Parameters.rom, undefined],
        ["rom.7", Parameters.romBank, "7"],
        ["ROM.f", Parameters.romBank, "F"],
    ])("finds %s", (name, parameter, member) => {
        expect(parameterFor(name)).toEqual(member === undefined ? { parameter } : { parameter, member });
    });

    it.each(["keyMapping", "gamepadMapping", "fire", "KEY", "constructor", "nothingAtAll"])(
        "finds nothing for %s",
        (name) => {
            expect(parameterFor(name)).toBeUndefined();
        },
    );
});

describe("processInputParams", () => {
    const context = (overrides) => ({
        machineKeys: { CTRL: "CTRL", SHIFT: "SHIFT" },
        hostKeyCodes: (name) => (["A", "B"].includes(name) ? [`Key${name}`] : []),
        userKeymap: [],
        gamepad: { remap: vi.fn() },
        ...overrides,
    });

    it("maps keys and gamepad controls, whatever the case of the prefix", () => {
        const page = context();
        const warnings = processInputParams(
            { "KEY.A": "ctrl", "key.b": "SHIFT", "GP.FIRE2": "RETURN", "gp.fire1": "space", UP: "Q", other: "value" },
            page,
        );

        expect(warnings).toEqual([]);
        expect(page.userKeymap).toEqual([
            { native: "A", key: "CTRL" },
            { native: "B", key: "SHIFT" },
        ]);
        expect(page.gamepad.remap.mock.calls).toEqual([
            ["FIRE2", "RETURN"],
            ["FIRE1", "SPACE"],
            ["UP", "Q"],
        ]);
    });

    it("leaves alone a mapping with no value, and a shorthand control not in capitals", () => {
        const page = context();
        processInputParams({ "KEY.A": "", "GP.FIRE2": null, up: "Q" }, page);

        expect(page.userKeymap).toEqual([]);
        expect(page.gamepad.remap).not.toHaveBeenCalled();
    });

    it("says what is wrong with each mapping it cannot make", () => {
        const page = context({
            gamepad: { remap: vi.fn().mockReturnValue('unknown gamepad control "WIBBLE".') },
        });
        const warnings = processInputParams({ "KEY.A": "NOTAKEY", "KEY.NOTAKEY": "CTRL", "GP.WIBBLE": "CTRL" }, page);

        expect(warnings).toEqual([
            'KEY.A=NOTAKEY: "NOTAKEY" is not a key on the emulated machine.',
            'KEY.NOTAKEY=CTRL: "NOTAKEY" is not a key on your keyboard.',
            'GP.WIBBLE=CTRL: unknown gamepad control "WIBBLE".',
        ]);
        expect(page.userKeymap).toEqual([]);
    });
});

describe("the rom. family", () => {
    const apply = (params) => {
        const bankRoms = [];
        const warnings = processInputParams(params, { bankRoms });
        return { bankRoms, warnings };
    };

    it("reads its name as the bank, 0 to 15 or A to F, and keeps the reference as it was given", () => {
        expect(
            apply({ "rom.7": ["github:mattgodbolt/xmos/original.rom"], "ROM.12": ["a.rom"], "rom.f": ["Mixed.ROM"] }),
        ).toEqual({
            bankRoms: [
                { bank: 7, rom: "github:mattgodbolt/xmos/original.rom" },
                { bank: 12, rom: "a.rom" },
                { bank: 15, rom: "Mixed.ROM" },
            ],
            warnings: [],
        });
    });

    it("is parsed as a list, so a second value for the same name is seen", () => {
        expect(parseQueryString("rom.7=a.rom&rom.7=b.rom&rom=c.rom", urlParamType)).toEqual({
            "rom.7": ["a.rom", "b.rom"],
            rom: ["c.rom"],
        });
    });

    it("leaves rom for the free banks when rom.7 names one", () => {
        const params = parseQueryString("rom=x.rom&rom.7=y.rom", urlParamType);

        expect(params.rom).toEqual(["x.rom"]);
        expect(apply(params)).toEqual({ bankRoms: [{ bank: 7, rom: "y.rom" }], warnings: [] });
    });

    it("leaves alone a bank with no value", () => {
        expect(apply({ "rom.7": [""] })).toEqual({ bankRoms: [], warnings: [] });
    });

    it.each(["16", "G", "-1", "0x7", "&7", "007", "WIBBLE"])("says %s is not a bank", (bank) => {
        expect(apply({ [`rom.${bank}`]: ["a.rom"] })).toEqual({
            bankRoms: [],
            warnings: [
                `rom.${bank}=a.rom: "${bank.toUpperCase()}" is not a ROM bank, which is 0 to 15, or A to F in hex.`,
            ],
        });
    });

    it("loads the first ROM a bank is given and says the others are not loaded", () => {
        expect(
            apply({ "rom.7": ["a.rom", "b.rom"], "ROM.07": ["c.rom"], "rom.a": ["d.rom"], "rom.10": ["e.rom"] }),
        ).toEqual({
            bankRoms: [
                { bank: 7, rom: "a.rom" },
                { bank: 10, rom: "d.rom" },
            ],
            warnings: [
                "rom.7=a.rom,b.rom: bank 7 takes one ROM, so b.rom is not loaded.",
                "ROM.07=c.rom: bank 7 already has a.rom, so c.rom is not loaded.",
                "rom.10=e.rom: bank 10 already has d.rom, so e.rom is not loaded.",
            ],
        });
    });
});

describe("tubeCpuSpeedLabel", () => {
    it.each([
        ["a B's second processor at 1x", 1, "B-DFS1.2", "1x (3MHz)"],
        ["a Master's second processor at 1x", 1, "Master", "1x (4MHz)"],
        ["a fractional overclock", 1.6, "B-DFS1.2", "1.6x (4.8MHz)"],
        ["a repeating multiplier from a URL, readably", 4 / 3, "B-DFS1.2", "1.33x (4MHz)"],
    ])("shows %s", (_, multiplier, model, label) => {
        expect(tubeCpuSpeedLabel(multiplier, findModel(model))).toBe(label);
    });
});

describe("the settings a session guest takes from its host", () => {
    const takenNames = Object.keys(Parameters).filter((name) => Parameters[name].takenFromHost);

    it("are the fittings and the knobs that change how the machine runs", () => {
        expect(takenNames).toEqual([
            "coProcessor",
            "tubeCpuMultiplier",
            "hasMusic5000",
            "hasTeletextAdaptor",
            "hasEconet",
            "hasVideoNula",
            "fakeVideo",
            "stationId",
            "videoCyclesBatch",
            "cpuMultiplier",
        ]);
    });

    it("are neither local to the page nor kept in storage, which a reload to match would not override", () => {
        for (const name of takenNames) {
            expect(Parameters[name].localToPage, name).toBeFalsy();
            expect(Parameters[name].stored, name).toBeFalsy();
        }
    });

    it("never default to true, since a URL cannot say a BOOL is false", () => {
        for (const name of takenNames) expect(Parameters[name].default, name).not.toBe(true);
    });

    const otherValue = (name) =>
        ({ [ParamTypes.BOOL]: true, [ParamTypes.INT]: 7, [ParamTypes.FLOAT]: 2.5 })[Parameters[name].type];

    it.each(takenNames)("brings a page reloaded with the host's %s to the host's", (name) => {
        const host = takenFromHostValues(new Settings({ urlState: fakeUrlState(`?${name}=${otherValue(name)}`) }), {
            [name]: otherValue(name),
        });
        const guest = fakeUrlState("");
        const reloaded = fakeUrlState(new URL(guest.urlWith(readTakenFromHost(host))).search);
        const settings = new Settings({ urlState: reloaded });
        expect(takenFromHostValues(settings, reloaded.params)).toEqual(host);
        expect(matchesHost(readTakenFromHost(host), takenFromHostValues(settings, reloaded.params))).toBe(true);
    });

    it("takes a setting the host left out as its default, and any other as absent", () => {
        expect(readTakenFromHost({})).toMatchObject({ tubeCpuMultiplier: 1, hasVideoNula: false });
        expect(readTakenFromHost({}).cpuMultiplier).toBeUndefined();
    });

    it("refuses a host's value this page would not take from its own URL, and takes one of the wrong type as none", () => {
        expect(readTakenFromHost({ tubeCpuMultiplier: 0 })).toBeNull();
        expect(readTakenFromHost({ stationId: 1e21 })).toBeNull();
        expect(readTakenFromHost({ tubeCpuMultiplier: 2 })).toMatchObject({ tubeCpuMultiplier: 2 });
        expect(readTakenFromHost({ cpuMultiplier: "2" }).cpuMultiplier).toBeUndefined();
    });

    it("carries one marked in any table, with nothing else to change", () => {
        const table = {
            fitted: { type: ParamTypes.BOOL, takenFromHost: true, default: false },
            speed: { type: ParamTypes.FLOAT, takenFromHost: true },
            colour: { type: ParamTypes.STRING },
        };
        const host = takenFromHostValues({ fitted: true }, { speed: 2, colour: "red" }, table);
        expect(host).toEqual({ fitted: true, speed: 2 });

        const sent = readTakenFromHost(JSON.parse(JSON.stringify(host)), table);
        expect(matchesHost(sent, takenFromHostValues({ fitted: true }, { speed: 2 }, table))).toBe(true);
        expect(matchesHost(sent, takenFromHostValues({ fitted: false }, { speed: 2 }, table))).toBe(false);
        expect(matchesHost(sent, takenFromHostValues({ fitted: true }, {}, table))).toBe(false);
    });

    it("takes a value absent from the URL as the same as one the host does not have", () => {
        const table = { speed: { type: ParamTypes.FLOAT, takenFromHost: true } };
        const sent = readTakenFromHost(JSON.parse(JSON.stringify(takenFromHostValues({}, {}, table))), table);
        expect(matchesHost(sent, takenFromHostValues({}, {}, table))).toBe(true);
    });
});

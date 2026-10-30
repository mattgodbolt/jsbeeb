import { hexbyte } from "../hex.js";
import {
    Command as IntelCommand,
    DriveOut,
    Result,
    State as IntelState,
    StatusFlag,
    TimerState as IntelTimerState,
} from "../intel-fdc.js";
import {
    Command as WdCommand,
    CommandBits as WdCommandBits,
    Control,
    State as WdState,
    Status,
    TimerState as WdTimerState,
} from "../wd-fdc.js";
import { decodedPanel, DecodedRegisters, fixed, lit, register, spelt } from "./decoded-registers.js";
import { Centred, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 240, h: 160 };
const MaxLogLines = 10000;
const LogStorageKey = "fdcLog";
const ResultCodeMask = 0x1e;
const SectorCountMask = 0x1f;
const SectorSizeShift = 5;
const SmallestSectorBytes = 128;
const IntelParamCount = 5;
const WdCommandMask = 0xf0;
const Acronyms = new Set(["id", "crc", "dma", "fm", "mfm"]);

/** An enum's name for a value, as words: `syncingForIdWait` as "syncing for ID wait". */
function spellName(values, value) {
    const name = Object.keys(values).find((key) => values[key] === value) ?? `&${hexbyte(value)}`;
    return name
        .replaceAll("_", " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(" ")
        .map((word) => (Acronyms.has(word) ? word.toUpperCase() : word))
        .join(" ");
}

const spellingsOf = (values) => Object.values(values).map((value) => spellName(values, value));

/** Lights for a register's named bits, in the order given. */
const bitLights = (value, bits) => bits.map(([mask, text, title]) => lit(text, title, value & mask));

// ---- The 8271 ----

const track = { title: "the track", describe: (value) => `track ${value}` };
const sector = { title: "the first sector", describe: (value) => `sector ${value}` };
const sizeAndCount = {
    title: "bits 5-7 the sector size, 128 bytes doubled that many times; bits 0-4 how many sectors",
    describe: (value) => `${value & SectorCountMask} × ${SmallestSectorBytes << (value >>> SectorSizeShift)} bytes`,
};
const gap = (n) => ({ title: `the length of gap ${n}`, describe: (value) => `gap ${n}: ${value}` });
const specialRegister = { title: "the special register", describe: (value) => `register &${hexbyte(value)}` };

const IntelParams = new Map([
    ...[
        IntelCommand.scanData,
        IntelCommand.scanDataAndDeleted,
        IntelCommand.writeData,
        IntelCommand.writeDeletedData,
        IntelCommand.readData,
        IntelCommand.readDataAndDeleted,
        IntelCommand.verify,
    ].map((command) => [command, [track, sector, sizeAndCount]]),
    [IntelCommand.readId, [track, null, { title: "how many IDs to read", describe: (value) => `${value} IDs` }]],
    [IntelCommand.format, [track, gap(3), sizeAndCount, gap(5), gap(1)]],
    [IntelCommand.seek, [track]],
    [IntelCommand.specify, [{ ...specialRegister, title: "the first register the next three parameters set" }]],
    [
        IntelCommand.writeSpecialRegister,
        [specialRegister, { title: "the value written", describe: (value) => `value &${hexbyte(value)}` }],
    ],
    [IntelCommand.readSpecialRegister, [specialRegister]],
]);

const IntelCommandNames = spellingsOf(IntelCommand);
const ResultCodes = Object.fromEntries(Object.entries(Result).filter(([, code]) => code & ResultCodeMask || !code));
const ResultNames = spellingsOf(ResultCodes);

function intelPhase({ state, timerState, awaitingParams }) {
    if (awaitingParams) return "waiting for parameters";
    if (timerState === IntelTimerState.seekStep) return "stepping";
    if (timerState === IntelTimerState.postSeek) return "settling";
    return spellName(IntelState, state);
}
const IntelPhases = ["waiting for parameters", ...spellingsOf(IntelState)];

const paramRow = (index) =>
    register(
        `P${index + 1}`,
        `Parameter ${index + 1}, as the 8271 holds it: some count down as the command runs`,
        8,
        (s) => s.params[index],
        (value, { command }) => {
            const param = IntelParams.get(command)?.[index];
            return param ? [fixed(param.describe(value), param.title)] : [];
        },
    );

const IntelSections = {
    command: [
        {
            heading: "Command",
            registers: [
                register(
                    "CMD",
                    "The command, without its drive select and parameter count bits",
                    8,
                    (s) => s.command,
                    (value) => [spelt(spellName(IntelCommand, value), "The command", IntelCommandNames)],
                ),
                ...Array.from({ length: IntelParamCount }, (_, index) => paramRow(index)),
            ],
        },
        {
            heading: "Status",
            registers: [
                register(
                    "STA",
                    "The status register",
                    8,
                    (s) => s.status,
                    (value) =>
                        bitLights(value, [
                            [StatusFlag.busy, "busy", "Busy with a command"],
                            [StatusFlag.commandFull, "cmd full", "The command register is full"],
                            [StatusFlag.paramFull, "param full", "The parameter register is full"],
                            [StatusFlag.resultReady, "result", "A result is ready to read"],
                            [StatusFlag.nmi, "NMI", "Asking for an NMI"],
                            [StatusFlag.needData, "data", "Waiting for a data byte to be read or written"],
                        ]),
                ),
                register(
                    "RES",
                    "The result of the last command",
                    8,
                    (s) => s.result,
                    (value) => [
                        spelt(spellName(ResultCodes, value & ResultCodeMask), "Bits 1-4: how it ended", ResultNames),
                        lit(
                            "deleted data",
                            "Bit 5: a sector read had the deleted data mark",
                            value & Result.flagDeletedData,
                        ),
                    ],
                ),
                register(
                    "PHASE",
                    "Where the 8271 is in the command",
                    8,
                    (s) => s.state,
                    (_, s) => [spelt(intelPhase(s), "What the 8271 is doing", IntelPhases)],
                ),
            ],
        },
    ],
    drive: [
        {
            heading: "Drive lines",
            registers: [
                register(
                    "OUT",
                    "The drive output lines",
                    8,
                    (s) => s.driveOut,
                    (value) =>
                        bitLights(value, [
                            [DriveOut.select_1, "sel 1", "Drive 1 selected"],
                            [DriveOut.select_0, "sel 0", "Drive 0 selected"],
                            [DriveOut.side, "side 1", "The upper side"],
                            [DriveOut.lowHeadCurrent, "low I", "Low head current, for the inner tracks"],
                            [DriveOut.loadHead, "load", "Load head: the head on the disc and the motor on"],
                            [DriveOut.direction, "in", "Step direction: towards the centre"],
                            [DriveOut.step, "step", "Step pulse"],
                            [DriveOut.writeEnable, "write", "Write enable"],
                        ]),
                ),
                ...[0, 1].map((drive) =>
                    register(
                        `TRK${drive}`,
                        `Where the 8271 believes drive ${drive}'s head is`,
                        8,
                        (s) => s.trackRegisters[drive],
                        (value) => [fixed(`track ${value}`, `The 8271's track register for drive ${drive}`)],
                    ),
                ),
            ],
        },
    ],
};

/** The drives a select pattern names, as words to follow a command's name. */
function drivesNamed(selected) {
    const drives = selected.flatMap((on, drive) => (on ? [drive] : []));
    if (!drives.length) return "";
    return drives.length === 1 ? `, drive ${drives[0]}` : `, drives ${drives.join(" and ")}`;
}

const headOn = (headTrack) => (headTrack === null ? "" : ` (head on track ${headTrack})`);
const hexBytes = (values) => values.map(hexbyte).join(" ");

const IntelValueResults = new Set([IntelCommand.readDriveStatus, IntelCommand.readSpecialRegister]);

function intelLogLine(entry) {
    switch (entry.kind) {
        case "command": {
            const { byte, command, select, params, headTrack } = entry;
            const meanings = (IntelParams.get(command) ?? [])
                .slice(0, params.length)
                .flatMap((param, index) => (param ? [param.describe(params[index])] : []));
            const where = drivesNamed([select & DriveOut.select_0, select & DriveOut.select_1]);
            return {
                text: `${spellName(IntelCommand, command)}${where}${meanings.length ? `: ${meanings.join(", ")}` : ""}${headOn(headTrack)}`,
                raw: `cmd ${hexbyte(byte)}${params.length ? ` params ${hexBytes(params)}` : ""}`,
            };
        }
        case "result": {
            const { command, status, result } = entry;
            const deleted = result & Result.flagDeletedData ? ", deleted data" : "";
            return {
                text: IntelValueResults.has(command)
                    ? `result &${hexbyte(result)}`
                    : `done: ${spellName(ResultCodes, result & ResultCodeMask)}${deleted}`,
                raw: `status ${hexbyte(status)} result ${hexbyte(result)}`,
            };
        }
        case "state":
            return { text: `state: ${spellName(IntelState, entry.from)} → ${spellName(IntelState, entry.to)}` };
        default:
            return { text: entry.text };
    }
}

// ---- The 1770 ----

const WdCommandNames = spellingsOf(WdCommand);

/** The type of the command itself: a force interrupt with the controller idle leaves its last command in place. */
function wdCommandType(command) {
    if (command < WdCommand.readSector) return 1;
    if (command < WdCommand.readAddress) return 2;
    return 3;
}

function wdCommandMeaning(value, { commandType: typeInForce, isVerify, isMulti, isSettle, isDeleted, stepRateMs }) {
    if (!typeInForce) return [];
    const commandType = wdCommandType(value);
    const meanings = [spelt(spellName(WdCommand, value), `A type ${commandType} command`, WdCommandNames)];
    if (commandType === 1)
        meanings.push(
            lit("verify", "Read an ID at the end of the seek to check the track", isVerify),
            fixed(`${stepRateMs} ms`, "The step rate"),
        );
    if (commandType === 2) meanings.push(lit("multi", "Go on to the next sector", isMulti));
    if (commandType !== 1) meanings.push(lit("settle", "Wait for the head to settle first", isSettle));
    if (value === WdCommand.writeSector || value === WdCommand.writeSectorMulti)
        meanings.push(lit("deleted", "Write a deleted data mark", isDeleted));
    return meanings;
}

const WdTypeIStatus = [
    [Status.motorOn, "motor", "The motor is on"],
    [Status.writeProtected, "WP", "The disc is write protected"],
    [Status.typeISpinUpDone, "spun up", "The motor has spun up"],
    [Status.recordNotFound, "seek err", "Seek error: the verify found no ID with the track number"],
    [Status.crcError, "CRC", "A CRC error in an ID"],
    [Status.typeITrack0, "track 0", "The head is over track 0"],
    [Status.typeIIndex, "index", "The index pulse"],
    [Status.busy, "busy", "Busy with a command"],
];
const WdTypeIIStatus = [
    [Status.motorOn, "motor", "The motor is on"],
    [Status.writeProtected, "WP", "A write was refused: the disc is write protected"],
    [Status.typeIIorIIIDeletedMark, "deleted", "The sector read had a deleted data mark"],
    [Status.recordNotFound, "not found", "The sector was not found"],
    [Status.crcError, "CRC", "A CRC error"],
    [Status.typeIIorIIILostByte, "lost", "A byte was lost: the host was too slow"],
    [Status.typeIIorIIIDrq, "DRQ", "A data byte waits to be read or written"],
    [Status.busy, "busy", "Busy with a command"],
];

function wdPhase({ state, timerState }) {
    if (state === WdState.timerWait) return spellName(WdTimerState, timerState);
    return spellName(WdState, state);
}
const WdPhases = [...spellingsOf(WdState), ...spellingsOf(WdTimerState)];

const plainRow = (name, title, field, text) =>
    register(
        name,
        title,
        8,
        (s) => s[field],
        (value) => [fixed(text(value), title)],
    );

const WdSections = {
    command: [
        {
            heading: "Command",
            registers: [
                register("CMD", "The command, without its flag bits", 8, (s) => s.command, wdCommandMeaning),
                plainRow("TR", "The track register", "track", (value) => `track ${value}`),
                plainRow("SR", "The sector register", "sector", (value) => `sector ${value}`),
                plainRow("DR", "The data register", "data", (value) => `${value}`),
            ],
        },
        {
            heading: "Status",
            registers: [
                register(
                    "STA",
                    "The status register, whose bits mean different things after a seek",
                    8,
                    (s) => s.status,
                    (value, { commandType }) => bitLights(value, commandType > 1 ? WdTypeIIStatus : WdTypeIStatus),
                ),
                register(
                    "PHASE",
                    "Where the controller is in the command",
                    8,
                    (s) => s.state,
                    (_, s) => [spelt(wdPhase(s), "What the controller is doing", WdPhases)],
                ),
            ],
        },
    ],
    drive: [
        {
            heading: "Drive lines",
            registers: [
                register(
                    "CTL",
                    "The drive control latch, as the controller sees it",
                    8,
                    (s) => s.control,
                    (value) => [
                        lit("reset", "The controller is held in reset", !(value & Control.reset)),
                        spelt(value & Control.density ? "FM" : "MFM", "Single density (FM) or double (MFM)", ["MFM"]),
                        lit("side 1", "The upper side", value & Control.side),
                        lit("sel 1", "Drive 1 selected", value & Control.drive1),
                        lit("sel 0", "Drive 0 selected", value & Control.drive0),
                    ],
                ),
            ],
        },
    ],
};

const WdErrorBits = {
    1: [
        [Status.recordNotFound, "seek error"],
        [Status.crcError, "CRC error"],
    ],
    2: [
        [Status.writeProtected, "write protected"],
        [Status.recordNotFound, "not found"],
        [Status.crcError, "CRC error"],
        [Status.typeIIorIIILostByte, "lost data"],
    ],
};

const wdRegisters = ({ track, sector, data }) => `tr ${track} sr ${sector} dr ${data}`;

const wdWhere = (control) =>
    `${drivesNamed([control & Control.drive0, control & Control.drive1])}, side ${control & Control.side ? 1 : 0}`;

function wdCommandDetails({ byte, track, sector, data, stepRateMs }) {
    const command = byte & WdCommandMask;
    const commandType = wdCommandType(command);
    if (command === WdCommand.forceInterrupt) return [];
    if (commandType === 1) {
        const details = command === WdCommand.seek ? [`to track ${data} from ${track}`] : [];
        if (byte & WdCommandBits.typeIVerify) details.push("verify");
        return [...details, `${stepRateMs} ms steps`];
    }
    if (commandType === 2) {
        const isWrite = command === WdCommand.writeSector || command === WdCommand.writeSectorMulti;
        const deleted = isWrite && byte & WdCommandBits.typeIIDeleted ? ["deleted data mark"] : [];
        return [`track ${track} sector ${sector}`, ...deleted];
    }
    return [];
}

function wdLogLine(entry) {
    switch (entry.kind) {
        case "command": {
            const details = wdCommandDetails(entry);
            return {
                text:
                    `${spellName(WdCommand, entry.byte & WdCommandMask)}${wdWhere(entry.control)}` +
                    `${details.length ? `: ${details.join(", ")}` : ""}${headOn(entry.headTrack)}`,
                raw: `cmd ${hexbyte(entry.byte)} ${wdRegisters(entry)}`,
            };
        }
        case "result": {
            const errors = WdErrorBits[Math.min(entry.commandType, 2)]
                .filter(([mask]) => entry.status & mask)
                .map(([, text]) => text);
            const deleted =
                entry.commandType > 1 && entry.status & Status.typeIIorIIIDeletedMark ? ", deleted data" : "";
            return {
                text: `done: ${errors.length ? errors.join(", ") : "ok"}${deleted}`,
                raw: `status ${hexbyte(entry.status)}`,
            };
        }
        case "control": {
            const { value } = entry;
            const reset = value & Control.reset ? "" : ", held in reset";
            return {
                text: `control${wdWhere(value)}, ${value & Control.density ? "FM" : "MFM"}${reset}`,
                raw: `wrote ${hexbyte(entry.written)}`,
            };
        }
        case "state":
            return {
                text: `state: ${spellName(WdState, entry.from)} → ${spellName(WdState, entry.to)}`,
                raw: wdRegisters(entry),
            };
        default:
            return { text: entry.text };
    }
}

// ---- Either ----

const HeadSection = {
    heading: "Head",
    registers: [
        register(
            "HEAD",
            "The track the drive's head is over",
            8,
            (s) => s.head.track,
            (_, { head }) => [
                spelt(
                    `drive ${head.drive} side ${head.side} track ${head.track}`,
                    "The drive selected, or the last one that was, and the side and physical track under its head",
                    ["drive 0 side 0 track 00"],
                ),
                lit("selected", "The controller selects the drive", head.selected),
                lit("spinning", "The disc is turning", head.spinning),
            ],
        ),
    ],
};

/** A drive's own events as log lines, for the drive toggle. */
function driveEvents(drive, driveIndex, log) {
    const say = (text) => log({ kind: "drive", text: `drive ${driveIndex}: ${text}` });
    return [
        ["startSpinning", () => say("motor on")],
        ["stopSpinning", () => say("motor off")],
        [
            "seekStart",
            ({ steps, stepMs }) =>
                say(
                    `stepping ${Math.abs(steps)} ${Math.abs(steps) === 1 ? "track" : "tracks"} ${steps > 0 ? "in" : "out"}, ${stepMs} ms a step`,
                ),
        ],
        ["seekEnd", () => say(`head on track ${drive.logicalTrack}`)],
        ["headStop", () => say(`head against its stop at track ${drive.logicalTrack}`)],
    ].map(([type, listener]) => ({ drive, type, listener }));
}

/**
 * A floating panel showing the disc controller, the 8271 or the 1770, decoded: its command and parameters, where it
 * is in the command, its status and result, the drive lines and the head. It logs the controller's commands, its state
 * changes and the drives' events while each is switched on, and the controller's warnings always.
 */
export class FdcPanel {
    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {{zoomToHead: (driveIndex: number) => void}} options.visualiser
     * @param {(() => Storage) | null} options.storage - where the log's switches are kept between visits, or null
     */
    constructor({ cpu, arrangement, visualiser, storage }) {
        this._fdc = cpu.fdc;
        this._storage = storage;
        const { floating, body, part } = decodedPanel({
            id: "fdc",
            title: "Disc controller",
            feature: "disc_controller",
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
            draw: () => this.update(),
        });
        this.floating = floating;
        body.innerHTML = `
            <div class="fdc-registers"></div>
            <div>
                <div class="fdc-drive"></div>
                <button type="button" class="txt-btn fdc-zoom" tabindex="-1"
                    title="Open the disc surface on this side, zoomed in on the head">show the head on the disc</button>
            </div>
            <div class="fdc-log-area">
                <div class="decoded-heading fdc-log-heading">
                    Log
                    <button type="button" class="decoded-bit fdc-log-commands" tabindex="-1"
                        title="Log each command the controller is given, with its parameters and result">commands</button>
                    <button type="button" class="decoded-bit fdc-log-states" tabindex="-1"
                        title="Log each change of the controller's state; there are a great many">state changes</button>
                    <button type="button" class="decoded-bit fdc-log-drives" tabindex="-1"
                        title="Log the drives' motors starting and stopping, and their heads stepping">drives</button>
                    <input type="text" class="form-control form-control-sm panel-field fdc-log-filter"
                        aria-label="Show only the lines containing this" placeholder="filter" />
                    <button type="button" class="txt-btn fdc-log-copy" tabindex="-1"
                        title="Copy the lines shown to the clipboard">copy</button>
                    <button type="button" class="txt-btn fdc-log-clear" tabindex="-1">clear</button>
                </div>
                <div class="fdc-log"></div>
            </div>`;
        const { chip } = this._fdc.inspect();
        const sections = chip === "8271" ? IntelSections : WdSections;
        this._logLine = chip === "8271" ? intelLogLine : wdLogLine;
        const [commandSection, ...otherSections] = sections.command;
        this._registers = [
            new DecodedRegisters(part("fdc-registers"), [
                { ...commandSection, heading: `${chip} command` },
                ...otherSections,
            ]),
            new DecodedRegisters(part("fdc-drive"), [...sections.drive, HeadSection]),
        ];
        part("fdc-zoom").addEventListener("click", () => visualiser.zoomToHead(this._fdc.inspect().lastSelectedDrive));

        this._log = part("fdc-log");
        this._followingLog = true;
        this._followedTo = 0;
        this._log.addEventListener("scroll", () => {
            const log = this._log;
            // Lines may have come between following them and this event, so only a scroll back up stops following.
            this._followingLog =
                log.scrollTop >= this._followedTo || log.scrollTop + log.clientHeight >= log.scrollHeight - 1;
        });
        this._fdc.onLog = (entry) => this._appendLog(entry);

        this._driveListeners = this._fdc.drives.flatMap((drive, index) =>
            driveEvents(drive, index, (entry) => this._appendLog(entry)),
        );
        this._loggingDrives = false;
        this._logToggles = [
            {
                name: "commands",
                button: part("fdc-log-commands"),
                isOn: () => this._fdc.logCommands,
                set: (on) => (this._fdc.logCommands = on),
            },
            {
                name: "states",
                button: part("fdc-log-states"),
                isOn: () => this._fdc.logStateChanges,
                set: (on) => (this._fdc.logStateChanges = on),
            },
            {
                name: "drives",
                button: part("fdc-log-drives"),
                isOn: () => this._loggingDrives,
                set: (on) => this._logDrives(on),
            },
        ];
        for (const toggle of this._logToggles)
            toggle.button.addEventListener("click", () => {
                toggle.set(!toggle.isOn());
                this._showLogging();
                this._saveLogging();
            });

        this._filter = "";
        const filter = part("fdc-log-filter");
        filter.addEventListener("input", () => {
            this._filter = filter.value.toLowerCase();
            for (const line of this._log.children) line.hidden = !this._shows(line);
        });
        filter.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                filter.value = "";
                filter.dispatchEvent(new Event("input"));
            }
            if (event.key === "Enter") filter.blur();
        });
        const copy = part("fdc-log-copy");
        // The clipboard is only there on a secure origin.
        copy.hidden = !navigator.clipboard;
        copy.addEventListener("click", () => this._copyLog());
        part("fdc-log-clear").addEventListener("click", () => this._log.replaceChildren());
        this._restoreLogging();
        this._showLogging();
        this.update();
    }

    _logDrives(on) {
        if (on === this._loggingDrives) return;
        this._loggingDrives = on;
        for (const { drive, type, listener } of this._driveListeners) {
            if (on) drive.addEventListener(type, listener);
            else drive.removeEventListener(type, listener);
        }
    }

    _showLogging() {
        for (const { button, isOn } of this._logToggles) {
            button.classList.toggle("lit", isOn());
            button.setAttribute("aria-pressed", String(isOn()));
        }
    }

    _restoreLogging() {
        if (!this._storage) return;
        let saved;
        try {
            saved = JSON.parse(this._storage().getItem(LogStorageKey) ?? "null");
        } catch (error) {
            console.warn(`Could not read the disc controller's log switches: ${error}`);
            return;
        }
        for (const { name, set } of this._logToggles) set(saved?.[name] === true);
    }

    _saveLogging() {
        if (!this._storage) return;
        const saved = Object.fromEntries(this._logToggles.map(({ name, isOn }) => [name, isOn()]));
        try {
            this._storage().setItem(LogStorageKey, JSON.stringify(saved));
        } catch (error) {
            console.warn(`Could not save the disc controller's log switches: ${error}`);
        }
    }

    _shows(line) {
        return !this._filter || line.textContent.toLowerCase().includes(this._filter);
    }

    /** @param {import("../fdc.js").FdcLogEntry | {kind: "drive", text: string}} entry */
    _appendLog(entry) {
        const { text, raw } = this._logLine(entry);
        const isWarning = entry.kind === "warning";
        const line = document.createElement("div");
        line.textContent = isWarning ? `warning: ${text}` : text;
        if (raw) {
            const rawPart = document.createElement("span");
            rawPart.className = "fdc-log-raw";
            rawPart.textContent = raw;
            line.append("  ", rawPart);
        }
        // console.log(line.textContent);
        line.classList.toggle("fdc-log-warning", isWarning);
        line.hidden = !this._shows(line);
        this._log.append(line);
        if (this._log.childElementCount > MaxLogLines) this._log.firstElementChild.remove();
    }

    _copyLog() {
        const shown = [...this._log.children].filter((line) => !line.hidden).map((line) => line.textContent);
        navigator.clipboard
            .writeText(shown.join("\n"))
            .catch((error) => console.warn(`Could not copy the disc controller's log: ${error}`));
    }

    update() {
        const state = this._fdc.inspect();
        const drive = this._fdc.drives[state.lastSelectedDrive];
        state.head = {
            drive: state.lastSelectedDrive,
            selected: state.selectedDrive !== null,
            side: drive.isSideUpper ? 1 : 0,
            track: drive.track,
            spinning: drive.spinning,
        };
        for (const registers of this._registers) registers.update(state);
        // Scrolled here, once a frame, rather than as each line comes, which would lay the page out for every one.
        if (this._followingLog) {
            this._log.scrollTop = this._log.scrollHeight;
            this._followedTo = this._log.scrollTop;
        }
    }
}

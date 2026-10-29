import { hexbyte } from "../hex.js";
import {
    Command as IntelCommand,
    DriveOut,
    Result,
    State as IntelState,
    StatusFlag,
    TimerState as IntelTimerState,
} from "../intel-fdc.js";
import { Command as WdCommand, Control, State as WdState, Status, TimerState as WdTimerState } from "../wd-fdc.js";
import { decodedPanel, DecodedRegisters, fixed, lit, register, spelt } from "./decoded-registers.js";
import { Centred, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 240, h: 160 };
const MaxLogLines = 500;
const ResultCodeMask = 0x1e;
const SectorCountMask = 0x1f;
const SectorSizeShift = 5;
const SmallestSectorBytes = 128;
const IntelParamCount = 5;
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
    if (isDeleted) meanings.push(lit("deleted", "Write a deleted data mark", isDeleted));
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

/**
 * A floating panel showing the disc controller, the 8271 or the 1770, decoded: its command and parameters, where it
 * is in the command, its status and result, the drive lines and the head. It can show the controller's log, and the
 * disc under the head.
 */
export class FdcPanel {
    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {{zoomToHead: (driveIndex: number) => void}} options.visualiser
     */
    constructor({ cpu, arrangement, visualiser }) {
        this._fdc = cpu.fdc;
        const { floating, body } = decodedPanel({
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
                <div class="decoded-heading">
                    Command log
                    <button type="button" class="txt-btn fdc-log-commands" tabindex="-1"
                        title="Log each command the controller is given, with its parameters and result"></button>
                    <button type="button" class="txt-btn fdc-log-states" role="checkbox" tabindex="-1"
                        title="Log each change of state too; there are a great many">state changes</button>
                    <button type="button" class="txt-btn fdc-log-clear" tabindex="-1">clear</button>
                </div>
                <div class="fdc-log"></div>
            </div>`;
        const part = (className) => body.querySelector(`.${className}`);
        const { chip } = this._fdc.inspect();
        const sections = chip === "8271" ? IntelSections : WdSections;
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
        this._log.addEventListener("scroll", () => {
            const log = this._log;
            this._followingLog = log.scrollTop + log.clientHeight >= log.scrollHeight - 1;
        });
        this._commandsButton = part("fdc-log-commands");
        this._statesButton = part("fdc-log-states");
        this._fdc.onLog = (line) => this._appendLog(line);
        this._commandsButton.addEventListener("click", () => {
            this._fdc.logCommands = !this._fdc.logCommands;
            this._showLogging();
        });
        this._statesButton.addEventListener("click", () => {
            this._fdc.logStateChanges = !this._fdc.logStateChanges;
            this._showLogging();
        });
        part("fdc-log-clear").addEventListener("click", () => this._log.replaceChildren());
        this._showLogging();
        this.update();
    }

    _showLogging() {
        const { logCommands, logStateChanges } = this._fdc;
        this._commandsButton.textContent = logCommands ? "stop" : "start";
        this._commandsButton.setAttribute("aria-pressed", String(logCommands));
        this._statesButton.textContent = `${logStateChanges ? "☑" : "☐"} state changes`;
        this._statesButton.setAttribute("aria-checked", String(logStateChanges));
    }

    _appendLog(text) {
        const line = document.createElement("div");
        line.textContent = text;
        this._log.append(line);
        if (this._log.childElementCount > MaxLogLines) this._log.firstElementChild.remove();
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
        if (this._followingLog) this._log.scrollTop = this._log.scrollHeight;
    }
}

import { describeBank, sidewaysBanks } from "../paging.js";
import { decodedPanel, DecodedRegisters, fixed, lit, namedBits, register } from "./decoded-registers.js";
import { Centred, StartEdge } from "./panel-layout.js";

const MinPanelSize = { w: 240, h: 120 };
const RomselAndyBit = 0x80;

const AccconBits = [
    { name: "D", title: "D: the screen shows shadow RAM" },
    { name: "E", title: "E: code running at &C000 to &DFFF, the VDU drivers, reads and writes shadow RAM at &3000" },
    { name: "X", title: "X: shadow RAM at &3000 to &7FFF for every access" },
    { name: "Y", title: "Y: HAZEL, 8K of filing system RAM, at &C000 to &DFFF instead of the MOS" },
    { name: "ITU", title: "ITU: the internal Tube, for a co-processor inside the case, instead of the external one" },
    { name: "IFJ", title: "IFJ: FRED and JIM, &FC00 to &FDFF, go to the cartridge sockets instead of the 1 MHz bus" },
    { name: "TST", title: "TST: &FC00 to &FEFF read the MOS ROM instead of the I/O" },
    { name: "IRR", title: "IRR: an interrupt request to the CPU" },
];

/** @typedef {{romsel: number, acccon: number, bank: number}} PagingState */

const bankName = (bank) => bank.toString(16).toUpperCase();

function decodeRomsel(romsel, { bank }, isMaster) {
    const meanings = [fixed(`bank ${bankName(bank)}`, `Sideways bank ${bank} is paged in at &8000 to &BFFF`)];
    if (isMaster) {
        meanings.push(lit("ANDY", "ANDY: the 4K of private RAM over &8000 to &8FFF", romsel & RomselAndyBit));
    }
    return meanings;
}

function sections(isMaster) {
    const registers = [
        register(
            "ROMSEL",
            "The sideways bank and, on a Master, ANDY, as last written",
            8,
            (state) => state.romsel,
            (value, state) => decodeRomsel(value, state, isMaster),
        ),
    ];
    if (isMaster) {
        registers.push(
            register(
                "ACCCON",
                "Which of the Master's RAM is paged in, and more",
                8,
                (state) => state.acccon,
                namedBits(AccconBits),
            ),
        );
    }
    return [{ heading: "Paging", registers }];
}

/**
 * A floating panel showing what the memory map has paged in: ROMSEL and, on a Master, ACCCON, decoded, and what is in
 * each sideways socket, the paged one lit. A socket's row shows that bank from its start (Debugger.showBank).
 */
export class PagingPanel {
    /** Whether the machine has paging to show: the Atom has none. */
    static fits(cpu) {
        return !cpu.model.isAtom;
    }

    /**
     * @param {object} options
     * @param {import("../6502.js").Cpu6502} options.cpu
     * @param {import("./floating-panel.js").PanelArrangement} options.arrangement
     * @param {(bank: number) => void} options.showBank
     */
    constructor({ cpu, arrangement, showBank }) {
        this._cpu = cpu;
        const { isMaster } = cpu.model;
        const { floating, body } = decodedPanel({
            id: "paging",
            title: "Paging and ROMs",
            feature: "paging",
            place: () => ({ x: Centred, y: StartEdge }),
            minSize: MinPanelSize,
            arrangement,
            draw: () => this.update(),
        });
        this.floating = floating;
        body.innerHTML = `<div class="paging-registers"></div><div class="paging-sockets"></div>`;
        this._registers = new DecodedRegisters(body.querySelector(".paging-registers"), sections(isMaster));
        this._sockets = this._socketTable(body.querySelector(".paging-sockets"), showBank);
        this.update();
    }

    _socketTable(container, showBank) {
        const table = document.createElement("table");
        table.className = "decoded-registers socket-table";
        const heading = table.createTBody().insertRow();
        heading.className = "decoded-heading";
        const headingCell = document.createElement("th");
        headingCell.colSpan = 3;
        headingCell.textContent = "Sockets";
        heading.append(headingCell);
        const body = table.createTBody();
        const sockets = sidewaysBanks(this._cpu.model)
            .reverse()
            .map((bank) => {
                const row = body.insertRow();
                row.className = "socket";
                row.title = `Show bank ${bankName(bank)} from &8000`;
                const name = document.createElement("th");
                name.textContent = bankName(bank);
                const kind = row.insertCell();
                kind.className = "socket-kind";
                kind.textContent = this._cpu.model.swram[bank] ? "RAM" : "ROM";
                const contents = row.insertCell();
                contents.className = "socket-contents";
                row.prepend(name);
                row.addEventListener("click", () => showBank(bank));
                return { bank, row, contents };
            });
        container.append(table);
        return sockets;
    }

    update() {
        const cpu = this._cpu;
        /** @type {PagingState} */
        const state = { romsel: cpu.romsel, acccon: cpu.acccon, bank: cpu.pagedBank };
        this._registers.update(state);
        for (const { bank, row, contents } of this._sockets) {
            const text = describeBank(cpu, bank);
            if (contents.textContent !== text) {
                contents.textContent = text;
                contents.title = text;
            }
            row.classList.toggle("paged", bank === state.bank);
        }
    }
}

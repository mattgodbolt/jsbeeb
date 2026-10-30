import { bankView, describeBank, sidewaysBanks } from "../paging.js";
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

const bankName = (bank) => bankView(bank).toUpperCase();

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
    /** Whether the machine has a BBC's paging to show: the Atom's own banks at &A000 are left out. */
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
        body.innerHTML = `
            <div>
                <div class="paging-registers"></div>
                <div class="decoded-heading paging-sockets-heading">Sockets</div>
                <div class="paging-socket-grid"></div>
            </div>`;
        this._registers = new DecodedRegisters(body.querySelector(".paging-registers"), sections(isMaster));
        this._sockets = this._socketGrid(body.querySelector(".paging-socket-grid"), showBank);
        this.update();
    }

    _socketGrid(container, showBank) {
        const sockets = sidewaysBanks(this._cpu.model)
            .reverse()
            .map((bank) => {
                const socket = document.createElement("div");
                socket.className = "paging-socket";
                socket.title = `Show bank ${bankName(bank)} from &8000`;
                const [name, kind, contents] = [
                    "paging-socket-bank",
                    "paging-socket-kind",
                    "paging-socket-contents",
                ].map((className) => {
                    const part = document.createElement("span");
                    part.className = className;
                    return part;
                });
                name.textContent = bankName(bank);
                kind.textContent = this._cpu.model.swram[bank] ? "RAM" : "ROM";
                socket.append(name, kind, contents);
                socket.addEventListener("click", () => showBank(bank));
                return { bank, socket, contents };
            });
        container.append(...sockets.map(({ socket }) => socket));
        return sockets;
    }

    update() {
        const cpu = this._cpu;
        /** @type {PagingState} */
        const state = { romsel: cpu.romsel, acccon: cpu.acccon, bank: cpu.pagedBank };
        this._registers.update(state);
        for (const { bank, socket, contents } of this._sockets) {
            const text = describeBank(cpu, bank);
            if (contents.textContent !== text) {
                contents.textContent = text;
                contents.title = text;
            }
            socket.classList.toggle("paged", bank === state.bank);
        }
    }
}

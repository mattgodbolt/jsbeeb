import { Ma13 } from "./video.js";

/**
 * Which DRAM rows the video and the CPU refresh, and the decay of rows that nothing refreshes. There is no refresh
 * counter: RAS falls on every 2 MHz slot whatever is addressed, so each CPU cycle and each character the CRTC counts
 * refreshes the row in its address's low bits (BBC Service Manual section 3.3; Advanced Master Reference Manual,
 * "Refresh Control").
 *
 * Normal running costs a few operations a scanline until the window's lines have refreshed every row. Only a window
 * that does not get there looks at rows one by one, and only one in CpuSampleWindows of those has the CPU take its
 * slow path to report the rows it touches.
 */

// Placeholders until a bench probe measures them. The #1849 probe's Master failed after about half a minute.
export const DramRetentionSeconds = 30;
export const DecayedByte = 0xff;

// Short enough that every PAL field ends one, long enough that the fields of an unprogrammed CRTC do not.
const RefreshWindowSeconds = 0.01;
const CpuSampleWindows = 8;
const ModelBRows = 128;
const MasterRows = 256;
const RowsPerCharacter = 8;
const BitsPerWord = 32;
const EveryCharacterRow = 0x01010101;
const EvenRows = 0x55555555;
const OddRows = ~EvenRows;
const RefreshMa6 = 0x40;
const MasterOddRaMa7 = 0x80;

function setRows(words, from, to) {
    for (let word = from >>> 5; word * BitsPerWord < to; ++word) {
        const low = Math.max(from - word * BitsPerWord, 0);
        const high = Math.min(to - word * BitsPerWord, BitsPerWord);
        words[word] |= (-1 << low) & (-1 >>> (BitsPerWord - high));
    }
}

export class DramRefresh {
    /**
     * @param {import("./6502.js").Cpu6502} cpu
     * @param {Array<[number, number]>} regions the [start, end) ranges of `cpu.ramRomOs` held in DRAM, each starting
     * on a multiple of the row count, so that an index's low bits are its CPU address's
     */
    constructor(cpu, regions) {
        this.cpu = cpu;
        this.ram = cpu.ramRomOs;
        this.regions = regions;
        this.isMaster = cpu.model.isMaster;
        this.rowCount = this.isMaster ? MasterRows : ModelBRows;
        this.rowMask = this.rowCount - 1;
        this.videoRows = new Int32Array(this.rowCount / BitsPerWord);
        this.lineRows = new Int32Array(this.rowCount / BitsPerWord);
        this.cpuRows = new Uint8Array(this.rowCount);
        this.retentionCycles = DramRetentionSeconds * cpu.model.cyclesPerSecond;
        this.windowCycles = RefreshWindowSeconds * cpu.model.cyclesPerSecond;
        this.lastRefreshedAt = new Float64Array(this.rowCount);
        this.windowStart = 0;
        this.lastCoveredAt = 0;
        this.windows = 0;
        this.covered = false;
    }

    /** Every row counts as just refreshed, as at power on. */
    powerOn() {
        const now = this.cpu.scheduler.epoch;
        this.windowStart = now;
        this.lastCoveredAt = now;
        this.lastRefreshedAt.fill(now);
        this.startWindow();
        this.cpu.trackDramRows(false);
    }

    /**
     * Notes the rows refreshed by a scanline of `chars` characters from `firstMa` with row address `ra`.
     * `lastCharOnOddClock` is the 2 MHz phase of its last character.
     */
    refreshLine(firstMa, chars, ra, oneMhzCrtc, lastCharOnOddClock) {
        if (firstMa & Ma13) this.refreshTeletextLine(firstMa, chars, ra, oneMhzCrtc, lastCharOnOddClock);
        else this.refreshBitmapLine(firstMa, chars, ra);
        this.covered = this.videoRows.every((word) => word === -1);
    }

    refreshBitmapLine(firstMa, chars, ra) {
        const maValues = this.rowCount / RowsPerCharacter;
        const raRow = ra & (RowsPerCharacter - 1);
        if (chars >= maValues) {
            for (let word = 0; word < this.videoRows.length; ++word) this.videoRows[word] |= EveryCharacterRow << raRow;
            return;
        }
        for (let i = 0; i < chars; ++i) {
            const row = (((firstMa + i) & (maValues - 1)) * RowsPerCharacter) | raRow;
            this.videoRows[row >>> 5] |= 1 << (row & (BitsPerWord - 1));
        }
    }

    // Each MA13 character's other 2 MHz slot fetches with MA6 flipped, by the 1 MHz clock (BeebWiki "Address
    // translation"); a 2 MHz CRTC only sees that slot on alternate characters. The Master's MA7 flip is #1849's.
    refreshTeletextLine(firstMa, chars, ra, oneMhzCrtc, lastCharOnOddClock) {
        const line = this.lineRows;
        line.fill(0);
        const start = firstMa & this.rowMask;
        const end = start + Math.min(chars, this.rowCount);
        setRows(line, start, Math.min(end, this.rowCount));
        if (end > this.rowCount) setRows(line, 0, end - this.rowCount);

        const flip = RefreshMa6 | (this.isMaster && ra & 1 ? MasterOddRaMa7 : 0);
        const flipWords = (flip & this.rowMask) / BitsPerWord;
        let unflipped = -1;
        let flipped = -1;
        if (!oneMhzCrtc) {
            const lastMaOddRow = ((firstMa + chars - 1) & 1) === 1;
            unflipped = lastMaOddRow === lastCharOnOddClock ? EvenRows : OddRows;
            flipped = ~unflipped;
        }
        for (let word = 0; word < line.length; ++word) {
            this.videoRows[word] |= (line[word] & unflipped) | (line[word ^ flipWords] & flipped);
        }
    }

    /** At each flyback: decays the rows that have gone unrefreshed for longer than DramRetentionSeconds. */
    endOfField() {
        const now = this.cpu.scheduler.epoch;
        if (now - this.windowStart < this.windowCycles) return;
        this.windowStart = now;
        ++this.windows;
        if (this.covered) {
            this.lastCoveredAt = now;
            this.startWindow();
            this.cpu.trackDramRows(false);
            return;
        }
        const cpuSampled = this.cpu.tracksDramRows;
        for (let row = 0; row < this.rowCount; ++row) {
            const videoRefreshed = (this.videoRows[row >>> 5] >>> (row & (BitsPerWord - 1))) & 1;
            if (videoRefreshed || (cpuSampled && this.cpuRows[row])) {
                this.lastRefreshedAt[row] = now;
            } else if (now - Math.max(this.lastRefreshedAt[row], this.lastCoveredAt) > this.retentionCycles) {
                this.decayRow(row);
                this.lastRefreshedAt[row] = now;
            }
        }
        this.startWindow();
        this.cpu.trackDramRows(this.windows % CpuSampleWindows === 0);
    }

    startWindow() {
        this.covered = false;
        this.videoRows.fill(0);
        this.cpuRows.fill(0);
    }

    decayRow(row) {
        for (const [start, end] of this.regions) {
            for (let i = start + row; i < end; i += this.rowCount) this.ram[i] = DecayedByte;
        }
    }

    snapshotState() {
        return {
            windowStart: this.windowStart,
            windows: this.windows,
            lastCoveredAt: this.lastCoveredAt,
            lastRefreshedAt: this.lastRefreshedAt.slice(),
            covered: this.covered,
            videoRows: this.videoRows.slice(),
            cpuRows: this.cpuRows.slice(),
            cpuSampled: this.cpu.tracksDramRows,
        };
    }

    restoreState(state) {
        if (!state) {
            this.powerOn();
            return;
        }
        this.windowStart = state.windowStart;
        this.windows = state.windows;
        this.lastCoveredAt = state.lastCoveredAt;
        this.lastRefreshedAt.set(state.lastRefreshedAt);
        this.covered = state.covered;
        this.videoRows.set(state.videoRows);
        this.cpuRows.set(state.cpuRows);
        this.cpu.trackDramRows(state.cpuSampled);
    }
}

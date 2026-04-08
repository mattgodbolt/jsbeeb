// VDFS Host — JavaScript implementation of the b-em VDFS host protocol.
//
// The b-em VDFS ROM (public/roms/vdfs.rom) runs on the emulated 6502 and
// communicates with this host via four FRED-area I/O ports:
//   $FC5C  port_flags  — filesystem flags (R/W)
//   $FC5D  port_fsid   — filing-system ID (R/W)
//   $FC5E  port_cmd    — write to execute a host dispatch command
//   $FC5F  port_a      — write to pass the BBC A register to the host
//
// Protocol: ROM writes A to port_a ($FC5F), then writes a command code to
// port_cmd ($FC5E).  The host handles the command synchronously (all file
// data is pre-loaded into memory), then calls romDispatch() to redirect the
// 6502 PC into the ROM's own dispatch table so the ROM can finish the call.

"use strict";

// Channel constants — matches b-em MIN_CHANNEL / NUM_CHANNELS.
const MinChannel = 96;
const NumChannels = 32;

// Dispatch table indices (must match .disptab order in vdfs.asm).
const RomReturn = 0; // serv_done — just RTS
const RomFsStart = 1; // normal filing-system start
const RomFsBoot = 2; // filing-system start at boot
const RomFsInfo = 3; // OS filing-system info
const RomFsClaim = 4; // claim filing systems
const RomCat = 5; // *CAT
const RomEx = 6; // *EX
const RomInfo = 7; // *INFO
const RomHelpShort = 13;
const RomBreak = 22; // soft-reset handling
const RomCloseAll = 26; // close all channels
const RomOpt1 = 29; // *OPT 1 print

// Flags stored in port_flags.
const FlagVdfsActive = 0x01;
const FlagDfsMode = 0x02;
const FlagClaimDfs = 0x40;
const FlagClaimAdfs = 0x80;

// Filing-system numbers.
const FsNumVdfs = 0x11;
const FsNumDfs = 0x04;
const FsNumAdfs = 0x08;

export class VdfsHost {
    constructor(cpu) {
        this.cpu = cpu;
        // Files loaded from the host directory: Map<UPPERCASE_NAME, entry>
        // entry = { name, dir, data: Uint8Array, loadAddr, execAddr }
        this.files = new Map();
        this.dirTitle = "VDFS";
        // Open file channels: indexed 0..NumChannels-1, null = free.
        this.channels = new Array(NumChannels).fill(null);
        // Host-side state
        this.fsFlags = FlagVdfsActive | FlagDfsMode | FlagClaimDfs;
        this.fsNum = FsNumVdfs;
        this.regA = 0; // last value written to port_a
        this.saveY = 0; // Y saved across soft-reset
        this.romSlot = 0; // sideways ROM slot VDFS ROM is in
        // Catalog iterator state
        this._catFiles = null;
        this._catIdx = 0;
        this._catDfsDir = "$";
    }

    /** Load a set of BBC files into the virtual directory.
     *  files: Array of { name, dir, data, loadAddr, execAddr }
     */
    setFiles(files, title) {
        this.files = new Map();
        this.dirTitle = title || "VDFS";
        for (const f of files) {
            this.files.set(f.name.toUpperCase(), f);
        }
    }

    /** I/O read from $FC5C–$FC5F */
    read(addr) {
        switch (addr & 3) {
            case 0:
                return this.fsFlags & 0xff;
            case 1:
                return this.fsNum & 0xff;
            default:
                return 0xff;
        }
    }

    /** I/O write to $FC5C–$FC5F */
    write(addr, val) {
        switch (addr & 3) {
            case 0:
                this.fsFlags = val;
                break;
            case 1:
                this.fsNum = val;
                break;
            case 2:
                // port_cmd — execute host dispatch
                this._dispatch(val);
                break;
            case 3:
                // port_a — save BBC A register
                this.regA = val;
                break;
        }
    }

    // ── ROM dispatch ────────────────────────────────────────────────────────

    /** Redirect the 6502 PC to entry `act` in the ROM's dispatch table. */
    _romDispatch(act) {
        const cpu = this.cpu;
        const tableAddr = cpu.readmem(0x8001) | (cpu.readmem(0x8002) << 8);
        cpu.pc = cpu.readmem(tableAddr + act * 2) | (cpu.readmem(tableAddr + act * 2 + 1) << 8);
    }

    /** Write a BBC-style error at $100 and jump to it. */
    _vdfsError(errNum, msg) {
        const cpu = this.cpu;
        let addr = 0x100;
        cpu.writemem(addr++, 0x00); // BRK
        cpu.writemem(addr++, errNum & 0xff);
        for (let i = 0; i < msg.length; i++) cpu.writemem(addr++, msg.charCodeAt(i));
        cpu.writemem(addr, 0x00); // terminator
        cpu.pc = 0x100;
    }

    // ── Memory helpers ───────────────────────────────────────────────────────

    _readmem16(a) {
        return this.cpu.readmem(a) | (this.cpu.readmem(a + 1) << 8);
    }

    _readmem32(a) {
        return (
            (this.cpu.readmem(a) |
                (this.cpu.readmem(a + 1) << 8) |
                (this.cpu.readmem(a + 2) << 16) |
                (this.cpu.readmem(a + 3) << 24)) >>>
            0
        );
    }

    _writemem32(a, v) {
        v = v >>> 0;
        this.cpu.writemem(a, v & 0xff);
        this.cpu.writemem(a + 1, (v >>> 8) & 0xff);
        this.cpu.writemem(a + 2, (v >>> 16) & 0xff);
        this.cpu.writemem(a + 3, (v >>> 24) & 0xff);
    }

    _readZstr(a) {
        let s = "";
        for (let i = 0; i < 256; i++) {
            const ch = this.cpu.readmem(a + i);
            if (ch === 0 || ch === 0x0d) break;
            s += String.fromCharCode(ch);
        }
        return s;
    }

    // ── Filesystem helpers ────────────────────────────────────────────────────

    _findFile(rawName) {
        // Strip leading directory prefix (e.g. "$.FILE" → "FILE", "D.FILE" → "FILE").
        let name = rawName.toUpperCase().trim();
        const dot = name.lastIndexOf(".");
        if (dot !== -1 && dot < name.length - 1) name = name.substring(dot + 1);
        return this.files.get(name) || null;
    }

    _getChannel(ch) {
        const idx = ch - MinChannel;
        if (idx >= 0 && idx < NumChannels) return this.channels[idx];
        return null;
    }

    _allocChannel(obj) {
        for (let i = 0; i < NumChannels; i++) {
            if (!this.channels[i]) {
                this.channels[i] = obj;
                return i + MinChannel;
            }
        }
        return -1;
    }

    _freeChannel(ch) {
        const idx = ch - MinChannel;
        if (idx >= 0 && idx < NumChannels) this.channels[idx] = null;
    }

    _freeAllChannels() {
        this.channels.fill(null);
    }

    // Write file data into BBC RAM at the given 16-bit address.
    _loadFileData(data, addr) {
        for (let i = 0; i < data.length; i++) {
            this.cpu.writemem((addr + i) & 0xffff, data[i]);
        }
    }

    // ── Dispatch ──────────────────────────────────────────────────────────────

    _dispatch(cmd) {
        const a = this.regA;
        const x = this.cpu.x;
        const y = this.cpu.y;
        switch (cmd) {
            case 0x00:
                this._service(a, x, y);
                break;
            case 0x01:
                this._osfile(a, x, y);
                break;
            case 0x02:
                this._osargs(a, x, y);
                break;
            case 0x03:
                this._osbget(x, y);
                break;
            case 0x04:
                this._osbput(a, x, y);
                break;
            case 0x05:
                this._osgbpb(a, x, y);
                break;
            case 0x06:
                this._osfind(a, x, y);
                break;
            case 0x07:
                this._osfsc(a, x, y);
                break;
            case 0x08:
                this._checkRam();
                break;
            case 0x09:
                this._startup();
                break;
            case 0x0a:
                this._filesNext();
                break;
            case 0x0b:
                this._closeAll();
                break;
            case 0x0c:
                this._catNextAdfs();
                break;
            case 0x0d:
                this._catNextDfsdir();
                break;
            case 0x0e:
                this._catNextDfsnot();
                break;
            case 0x0f:
                this._catDfsRewind();
                break;
            default:
                this._romDispatch(RomReturn);
                break;
        }
    }

    // ── Host command handlers ─────────────────────────────────────────────────

    _startup() {
        // X = ROM slot number, Y = RAM/ROM split page.
        this.romSlot = this.cpu.x & 0x0f;
        this.cpu.a = 2; // signal "handled, don't re-enter service"
        this.cpu.y = this.saveY;
        // No romDispatch — the ROM just continues after the STA port_cmd.
    }

    _service(a, _x, y) {
        switch (a) {
            case 0x02: // soft reset (Break)
                this.saveY = y;
                this._romDispatch(RomBreak);
                break;
            case 0x03: // filing-system boot
                this.cpu.a = 0; // boot option 0 = no auto-start
                this._romDispatch(RomFsBoot);
                break;
            case 0x04: // unrecognised OS command — ROM handles *CAT etc.
                this._romDispatch(RomReturn);
                break;
            case 0x09: // *HELP
                this._romDispatch(RomHelpShort);
                break;
            case 0x12: // select filing system (decimal 18)
                if (
                    y === FsNumVdfs ||
                    ((this.fsFlags & FlagClaimDfs) && y === FsNumDfs) ||
                    ((this.fsFlags & FlagClaimAdfs) && y === FsNumAdfs)
                ) {
                    this.fsNum = y;
                    this._romDispatch(RomFsClaim);
                } else {
                    this._romDispatch(RomReturn);
                }
                break;
            default:
                this._romDispatch(RomReturn);
                break;
        }
    }

    _osfile(a, x, y) {
        const cpu = this.cpu;
        const pb = (y << 8) | x;
        const fnameAddr = this._readmem16(pb);
        const fname = this._readZstr(fnameAddr);

        switch (a) {
            case 0xff: {
                // Load file
                const entry = this._findFile(fname);
                if (!entry) {
                    this._vdfsError(0x0d, "File not found");
                    return;
                }
                // Use file's own load address unless exec-addr byte is 0
                // (b-em convention: if pb[6]==0 use pb load addr, else native).
                let loadAddr;
                if (cpu.readmem(pb + 6) === 0) {
                    loadAddr = this._readmem32(pb + 2);
                } else {
                    loadAddr = entry.loadAddr;
                }
                this._loadFileData(entry.data, loadAddr & 0xffff);
                this._writemem32(pb + 2, entry.loadAddr);
                this._writemem32(pb + 6, entry.execAddr);
                this._writemem32(pb + 10, entry.data.length);
                this._writemem32(pb + 14, 0x03); // attributes: public R/W
                cpu.a = 1;
                this._romDispatch(RomReturn);
                break;
            }
            case 0x05: {
                // Get file info (load/exec/length/attribs)
                const entry = this._findFile(fname);
                if (!entry) {
                    cpu.a = 0;
                    this._romDispatch(RomReturn);
                    return;
                }
                this._writemem32(pb + 2, entry.loadAddr);
                this._writemem32(pb + 6, entry.execAddr);
                this._writemem32(pb + 10, entry.data.length);
                this._writemem32(pb + 14, 0x03);
                cpu.a = 1;
                this._romDispatch(RomReturn);
                break;
            }
            case 0x06: {
                // Delete file — just acknowledge (read-only host)
                cpu.a = 0;
                this._romDispatch(RomReturn);
                break;
            }
            default:
                cpu.a = 0;
                this._romDispatch(RomReturn);
                break;
        }
    }

    _osargs(a, x, y) {
        const cpu = this.cpu;
        if (y === 0) {
            // Filing-system level
            if (a === 0) cpu.a = this.fsNum;
            this._romDispatch(RomReturn);
            return;
        }
        const ch = this._getChannel(y);
        if (!ch) {
            this._vdfsError(0x0e, "Channel");
            return;
        }
        switch (a) {
            case 0: // get sequential pointer
                this._writemem32(x, ch.pos);
                break;
            case 1: // set sequential pointer
                ch.pos = Math.min(this._readmem32(x), ch.data.length);
                break;
            case 2: // get extent
                this._writemem32(x, ch.data.length);
                break;
            case 0xff: // flush (no-op for read-only)
                break;
        }
        this._romDispatch(RomReturn);
    }

    _osbget(_a, _x, y) {
        const cpu = this.cpu;
        const ch = this._getChannel(y);
        if (!ch || !ch.readable) {
            cpu.a = 0xfe;
            cpu.p.c = true;
            this._romDispatch(RomReturn);
            return;
        }
        if (ch.pos >= ch.data.length) {
            cpu.a = 0xfe;
            cpu.p.c = true;
        } else {
            cpu.a = ch.data[ch.pos++];
            cpu.p.c = false;
        }
        this._romDispatch(RomReturn);
    }

    _osbput(a, _x, y) {
        const ch = this._getChannel(y);
        if (!ch || !ch.writable) {
            this._vdfsError(0x93, "Not open for update");
            return;
        }
        if (ch.pos >= ch.writeData.length) {
            const bigger = new Uint8Array(ch.pos + 256);
            bigger.set(ch.writeData);
            ch.writeData = bigger;
        }
        ch.writeData[ch.pos++] = a;
        this._romDispatch(RomReturn);
    }

    _osgbpb(a, x, y) {
        const cpu = this.cpu;
        const pb = (y << 8) | x;
        switch (a) {
            case 1: // put bytes at specified position (write — not supported)
            case 2: // put bytes at current position  (write — not supported)
                this._romDispatch(RomReturn);
                break;
            case 3: // get bytes from specified position
            case 4: {
                // get bytes from current position
                const ch = this._getChannel(cpu.readmem(pb));
                if (!ch) {
                    this._vdfsError(0x0e, "Channel");
                    return;
                }
                if (a === 3) ch.pos = this._readmem32(pb + 9);
                let memPtr = this._readmem32(pb + 1);
                const total = this._readmem32(pb + 5) >>> 0;
                let remaining = 0;
                for (let i = 0; i < total; i++) {
                    if (ch.pos >= ch.data.length) {
                        remaining = total - i;
                        break;
                    }
                    cpu.writemem(memPtr++ & 0xffff, ch.data[ch.pos++]);
                }
                this._writemem32(pb + 1, memPtr);
                this._writemem32(pb + 5, remaining);
                this._writemem32(pb + 9, ch.pos);
                cpu.p.c = remaining > 0;
                this._romDispatch(RomReturn);
                break;
            }
            case 5: {
                // Get disc title and drive name
                const memPtr = this._readmem32(pb + 1);
                const title = this.dirTitle;
                cpu.writemem(memPtr, title.length);
                for (let i = 0; i < title.length; i++) cpu.writemem(memPtr + 1 + i, title.charCodeAt(i));
                cpu.writemem(memPtr + 1 + title.length, 0); // boot opt
                this._romDispatch(RomReturn);
                break;
            }
            default:
                this._romDispatch(RomReturn);
                break;
        }
    }

    _osfind(a, x, y) {
        const cpu = this.cpu;
        if (a === 0) {
            // Close
            if (y === 0) {
                this._romDispatch(RomCloseAll);
            } else {
                this._freeChannel(y);
                this._romDispatch(RomReturn);
            }
            return;
        }
        // Open file — filename is at address (y<<8)|x
        const fnAddr = (y << 8) | x;
        const fname = this._readZstr(fnAddr);
        const entry = this._findFile(fname);
        if (!entry) {
            cpu.a = 0; // not found
            this._romDispatch(RomReturn);
            return;
        }
        const readable = (a & 0x40) !== 0;
        const writable = (a & 0x80) !== 0;
        const data = entry.data.slice(); // copy so we don't mutate cached file
        const ch = this._allocChannel({
            data,
            pos: 0,
            readable,
            writable,
            writeData: writable ? new Uint8Array(data) : null,
            name: entry.name,
        });
        cpu.a = ch === -1 ? 0 : ch;
        this._romDispatch(RomReturn);
    }

    _osfsc(a, x, y) {
        const cpu = this.cpu;
        cpu.p.c = false;
        switch (a) {
            case 0x00: // *OPT x,y
                this._romDispatch(RomReturn);
                break;
            case 0x01: {
                // EOF check: return 0xff in X if at EOF, 0 otherwise
                const ch = this._getChannel(x);
                if (ch) cpu.x = ch.pos >= ch.data.length ? 0xff : 0;
                this._romDispatch(RomReturn);
                break;
            }
            case 0x02: // */ command
            case 0x04: {
                // *RUN — load and execute
                const fnAddr = (y << 8) | x;
                const fname = this._readZstr(fnAddr).trim();
                const entry = this._findFile(fname);
                if (!entry) {
                    this._vdfsError(0x0d, "File not found");
                    return;
                }
                this._loadFileData(entry.data, entry.loadAddr & 0xffff);
                cpu.pc = entry.execAddr & 0xffff;
                break; // no romDispatch — we set PC directly
            }
            case 0x03: // unrecognised OS command — ROM handles *CAT etc.
                this._romDispatch(RomReturn);
                break;
            case 0x05: {
                // *CAT — prepare catalog iterator and dispatch to ROM
                this._catFiles = Array.from(this.files.values());
                this._catIdx = 0;
                this._catDfsDir = "$";
                this._romDispatch(RomCat);
                break;
            }
            case 0x06: // another FS taking over
                this.fsFlags &= ~FlagVdfsActive;
                this._romDispatch(RomReturn);
                break;
            case 0x07: // this FS was selected
                this._romDispatch(RomFsStart);
                break;
            default:
                this._romDispatch(RomReturn);
                break;
        }
    }

    _checkRam() {
        this.cpu.a = 0;
        this._romDispatch(RomReturn);
    }

    _filesNext() {
        // Write info about the next open channel to page 1 ($0100+).
        const cpu = this.cpu;
        for (let i = 0; i < NumChannels; i++) {
            const ch = this.channels[i];
            if (ch) {
                cpu.writemem(0x100, i + MinChannel);
                const name = ch.name || "";
                for (let j = 0; j < 10; j++) {
                    cpu.writemem(0x101 + j, j < name.length ? name.charCodeAt(j) : 0x20);
                }
                cpu.writemem(0x10b, 0);
                this.channels[i] = null; // consume so next call advances
                cpu.p.c = false;
                this._romDispatch(RomReturn);
                return;
            }
        }
        this._romDispatch(26); // RomCloseAll / none_open path = RomNopen=24
    }

    _closeAll() {
        this._freeAllChannels();
        this._romDispatch(RomReturn);
    }

    // Catalog iteration — writes one entry to CAT_TMP ($0100) per call.
    // The ROM calls these repeatedly to build the *CAT display.

    _catFiles = null;
    _catIdx = 0;
    _catDfsDir = "$";

    _writeCatEntry(entry) {
        const cpu = this.cpu;
        let ptr = 0x100;
        const name = entry.name;
        const dir = entry.dir || "$";
        // gcopy_fn format: 2-char dir prefix + 7-char name field = 9 bytes
        if (dir === this._catDfsDir) {
            cpu.writemem(ptr++, 0x20); // ' '
            cpu.writemem(ptr++, 0x20); // ' '
        } else {
            cpu.writemem(ptr++, dir.charCodeAt(0));
            cpu.writemem(ptr++, ".".charCodeAt(0));
        }
        for (let i = 0; i < 7; i++) {
            cpu.writemem(ptr++, i < name.length ? name.charCodeAt(i) : 0x20);
        }
        // write_file_attr at mem_ptr (= $0109): attribs(2) + load(4) + exec(4) + len(4)
        cpu.writemem(ptr++, 0x03); // attribs lo byte
        cpu.writemem(ptr++, 0x00); // attribs hi byte
        this._writemem32(ptr, entry.loadAddr);
        ptr += 4;
        this._writemem32(ptr, entry.execAddr);
        ptr += 4;
        this._writemem32(ptr, entry.data.length);
    }

    _catNextTail(files) {
        const entry = files[this._catIdx];
        if (entry) {
            this._writeCatEntry(entry);
            this._catIdx++;
            this.cpu.p.c = false;
        } else {
            this.cpu.p.c = true;
        }
        this._romDispatch(RomReturn);
    }

    _catNextAdfs() {
        const files = this._catFiles || [];
        while (this._catIdx < files.length && !files[this._catIdx]) this._catIdx++;
        this._catNextTail(files);
    }

    _catNextDfsdir() {
        // Advance past files NOT in the current DFS directory
        const files = this._catFiles || [];
        while (this._catIdx < files.length) {
            const f = files[this._catIdx];
            if (f && (f.dir || "$") === this._catDfsDir) break;
            this._catIdx++;
        }
        this._catNextTail(files);
    }

    _catNextDfsnot() {
        // Advance past files IN the current DFS directory
        const files = this._catFiles || [];
        while (this._catIdx < files.length) {
            const f = files[this._catIdx];
            if (f && (f.dir || "$") !== this._catDfsDir) break;
            this._catIdx++;
        }
        this._catNextTail(files);
    }

    _catDfsRewind() {
        this._catIdx = 0;
        this._catNextDfsnot();
    }
}

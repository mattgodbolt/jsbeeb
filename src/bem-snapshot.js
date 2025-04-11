"use strict";

import * as utils from "./utils.js";
import { Flags } from "./6502.js";
import { SaveState } from "./savestate.js";

/**
 * B-Em Snapshot format constants
 */
const BEM_MAGIC = "BEMSNAP";
const BEM_CURRENT_VERSION = "3";
const BEM_HEADER_SIZE = 8; // Magic (7) + Version (1)

// B-Em section keys
const BEM_SECTIONS = {
    MODEL: "m",
    CPU: "6",
    MEMORY: "M",
    SYSVIA: "S",
    USERVIA: "U",
    VIDEO_ULA: "V",
    CRTC: "C",
    VIDEO: "v",
    SOUND: "s",
    ADC: "A",
    ACIA: "a",
    SERIAL: "r",
    VDFS: "F",
    MUSIC5000: "5",
    PAULA: "p",
    JIM: "J",
    TUBE_ULA: "T",
    TUBE_PROC: "P",
};

/**
 * Handles conversion between jsbeeb SaveState and B-Em snapshot format (.snp)
 */
export class BemSnapshotConverter {
    /**
     * Convert a B-Em snapshot file to a jsbeeb SaveState
     * @param {Uint8Array} bemData - Raw B-Em snapshot file data
     * @returns {SaveState} - jsbeeb SaveState object
     * @throws {Error} - If snapshot is invalid or unsupported
     */
    static fromBemSnapshot(bemData) {
        // Check magic and version
        const header = new TextDecoder().decode(bemData.slice(0, 7));
        if (header !== BEM_MAGIC) {
            throw new Error("Invalid B-Em snapshot file");
        }

        const version = String.fromCharCode(bemData[7]);
        if (version < "1" || version > "3") {
            throw new Error(`Unsupported B-Em snapshot version: ${version}`);
        }

        const saveState = new SaveState({ version: 1 });
        saveState.metadata.format = "bem-converted";
        saveState.metadata.bemVersion = version;

        // Parse sections based on version
        if (version === "1") {
            this._parseVersion1(bemData.slice(BEM_HEADER_SIZE), saveState);
        } else {
            this._parseSections(bemData.slice(BEM_HEADER_SIZE), saveState, version);
        }

        return saveState;
    }

    /**
     * Convert a jsbeeb SaveState to a B-Em snapshot file
     * @param {SaveState} saveState - jsbeeb SaveState object
     * @returns {Uint8Array} - Raw B-Em snapshot file data
     * @throws {Error} - If SaveState is invalid or cannot be converted
     */
    static toBemSnapshot(saveState) {
        // Create header
        const header = new TextEncoder().encode(BEM_MAGIC + BEM_CURRENT_VERSION);

        // Create sections
        const sections = [];

        // Add model section
        const modelSection = this._createModelSection(saveState);
        if (modelSection) sections.push(modelSection);

        // Add CPU section
        const cpuSection = this._createCpuSection(saveState);
        if (cpuSection) sections.push(cpuSection);

        // Add memory section (compressed)
        const memorySection = this._createMemorySection(saveState);
        if (memorySection) sections.push(memorySection);

        // Add system VIA section
        const sysViaSection = this._createSysViaSection(saveState);
        if (sysViaSection) sections.push(sysViaSection);

        // Add user VIA section
        const userViaSection = this._createUserViaSection(saveState);
        if (userViaSection) sections.push(userViaSection);

        // Add video ULA section
        const videoUlaSection = this._createVideoUlaSection(saveState);
        if (videoUlaSection) sections.push(videoUlaSection);

        // Add CRTC section
        const crtcSection = this._createCrtcSection(saveState);
        if (crtcSection) sections.push(crtcSection);

        // Add video section
        const videoSection = this._createVideoSection(saveState);
        if (videoSection) sections.push(videoSection);

        // Add sound chip section
        const soundSection = this._createSoundSection(saveState);
        if (soundSection) sections.push(soundSection);

        // Add other sections as needed

        // Combine all sections
        const totalLength = header.length + sections.reduce((sum, section) => sum + section.length, 0);
        const result = new Uint8Array(totalLength);
        result.set(header, 0);

        let offset = header.length;
        for (const section of sections) {
            result.set(section, offset);
            offset += section.length;
        }

        return result;
    }

    /**
     * Parse B-Em snapshot version 1
     * @private
     * @param {Uint8Array} data - Snapshot data (without header)
     * @param {SaveState} saveState - SaveState to populate
     */
    static _parseVersion1(data, saveState) {
        // Version 1 has a different fixed format, as specified in load_state_one function
        // Extract model info
        const model = data[0];
        saveState.addComponent("bem_model", { model });

        let offset = 1;

        // Extract CPU state (as specified in m6502_loadstate)
        const cpuState = this._parseCpuState(data.slice(offset, offset + 13));
        saveState.addComponent("cpu", cpuState);
        offset += 13;

        // There's more to parse, but we'll need to consult B-Em source for details
        // For now, just set the metadata
        saveState.metadata.conversionNote = "Incomplete conversion from B-Em v1 snapshot";
    }

    /**
     * Parse B-Em snapshot sections (version 2 or 3)
     * @private
     * @param {Uint8Array} data - Snapshot data (without header)
     * @param {SaveState} saveState - SaveState to populate
     * @param {string} version - B-Em snapshot version
     */
    static _parseSections(data, saveState, version) {
        let offset = 0;

        while (offset < data.length) {
            // Get section key and compression flag
            let key = String.fromCharCode(data[offset] & 0x7f);
            const isCompressed = !!(data[offset] & 0x80);
            offset++;

            // Get section size
            let size = 0;
            if (version === "2") {
                // Version 2 has different header format
                size = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
                offset += 3;
            } else {
                // Version 3
                if (isCompressed) {
                    size = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24);
                    offset += 4;
                } else {
                    size = data[offset] | (data[offset + 1] << 8);
                    offset += 2;
                }
            }

            // Extract section data
            const sectionData = data.slice(offset, offset + size);
            offset += size;

            // Process section based on key
            this._processBemSection(key, sectionData, isCompressed, saveState);
        }
    }

    /**
     * Process a B-Em section
     * @private
     * @param {string} key - Section key
     * @param {Uint8Array} data - Section data
     * @param {boolean} isCompressed - Whether section is compressed
     * @param {SaveState} saveState - SaveState to populate
     */
    static _processBemSection(key, data, isCompressed, saveState) {
        switch (key) {
            case BEM_SECTIONS.MODEL:
                saveState.addComponent("bem_model", {
                    model: data[0],
                    modelString: utils.uint8ArrayToString(data.slice(1)),
                });
                break;

            case BEM_SECTIONS.CPU:
                saveState.addComponent("cpu", this._parseCpuState(data));
                break;

            case BEM_SECTIONS.MEMORY:
                if (isCompressed) {
                    // Need to decompress zlib data
                    saveState.metadata.conversionNote = "Memory section requires zlib decompression";
                }
                // For now, store the raw data
                saveState.addComponent("bem_memory_raw", {
                    data,
                    compressed: isCompressed,
                });
                break;

            case BEM_SECTIONS.SYSVIA:
                saveState.addComponent("via_sys", this._parseViaState(data));
                break;

            case BEM_SECTIONS.USERVIA:
                saveState.addComponent("via_user", this._parseViaState(data));
                break;

            case BEM_SECTIONS.VIDEO_ULA:
                saveState.addComponent("video_ula", this._parseVideoUlaState(data));
                break;

            case BEM_SECTIONS.CRTC:
                saveState.addComponent("crtc", this._parseCrtcState(data));
                break;

            case BEM_SECTIONS.VIDEO:
                saveState.addComponent("video", this._parseVideoState(data));
                break;

            case BEM_SECTIONS.SOUND:
                saveState.addComponent("sound", this._parseSoundState(data));
                break;

            // Add parsers for other sections as needed

            default:
                // Store unknown sections as raw data
                saveState.addComponent(`bem_${key}_raw`, { data });
        }
    }

    /**
     * Parse B-Em CPU state
     * @private
     * @param {Uint8Array} data - CPU state data
     * @returns {Object} - jsbeeb CPU state
     */
    static _parseCpuState(data) {
        const a = data[0];
        const x = data[1];
        const y = data[2];
        const statusByte = data[3];
        const s = data[4];
        const pc = data[5] | (data[6] << 8);
        const nmi = data[7];
        const interrupt = data[8];

        // Create Flags object
        const statusFlags = new Flags();
        statusFlags.n = !!(statusByte & 0x80);
        statusFlags.v = !!(statusByte & 0x40);
        statusFlags.d = !!(statusByte & 0x08);
        statusFlags.i = !!(statusByte & 0x04);
        statusFlags.z = !!(statusByte & 0x02);
        statusFlags.c = !!(statusByte & 0x01);

        return {
            a,
            x,
            y,
            s,
            pc,
            p: statusFlags.saveState(),
            interrupt,
            _nmiLevel: nmi, // B-Em's nmi maps to jsbeeb's _nmiLevel
            _nmiEdge: false, // Not stored in B-Em snapshot
            takeInt: false, // Set to false initially
            halted: false, // Set to false initially
        };
    }

    /**
     * Parse B-Em VIA state
     * @private
     * @param {Uint8Array} data - VIA state data
     * @returns {Object} - jsbeeb VIA state
     */
    static _parseViaState(data) {
        const isSysVia = data.length > 33; // System VIA has an extra byte for IC32

        const state = {
            ora: data[0],
            orb: data[1],
            ira: data[2],
            irb: data[3],
            // Items at index 4-5 are port A read values (not stored in jsbeeb)
            ddra: data[6],
            ddrb: data[7],
            sr: data[8],
            acr: data[9],
            pcr: data[10],
            ifr: data[11],
            ier: data[12],
            t1l: data[13] | (data[14] << 8) | (data[15] << 16) | (data[16] << 24),
            t2l: data[17] | (data[18] << 8) | (data[19] << 16) | (data[20] << 24),
            t1c: data[21] | (data[22] << 8) | (data[23] << 16) | (data[24] << 24),
            t2c: data[25] | (data[26] << 8) | (data[27] << 16) | (data[28] << 24),
            t1hit: data[29],
            t2hit: data[30],
            ca1: data[31],
            ca2: data[32],
            // cb1 and cb2 are not stored in B-Em snapshots
            cb1: 0,
            cb2: 0,
        };

        if (isSysVia) {
            state.IC32 = data[33]; // Last byte is IC32 for System VIA
        }

        return state;
    }

    /**
     * Parse B-Em Video ULA state
     * @private
     * @param {Uint8Array} data - Video ULA state data
     * @returns {Object} - jsbeeb Video ULA state
     */
    static _parseVideoUlaState(data) {
        // Start with the control register
        const state = {
            controlReg: data[0],
        };

        // Add palette entries
        state.palette = Array.from(data.slice(1, 17));

        // NuLA state
        if (data.length >= 97) {
            state.nulaState = {
                palette: [], // RGBA values for each color
                writeFlag: data[81],
                firstByte: data[82],
                flash: Array.from(data.slice(83, 91)),
                paletteMode: data[91],
                horizontalOffset: data[92],
                leftBlank: data[93],
                disable: data[94],
                attributeMode: data[95],
                attributeText: data[96],
            };

            // Extract NuLA RGB palette
            for (let i = 0; i < 16; i++) {
                const offset = 17 + i * 4;
                state.nulaState.palette.push({
                    r: data[offset],
                    g: data[offset + 1],
                    b: data[offset + 2],
                    a: data[offset + 3],
                });
            }
        }

        return state;
    }

    /**
     * Parse B-Em CRTC state
     * @private
     * @param {Uint8Array} data - CRTC state data
     * @returns {Object} - jsbeeb CRTC state
     */
    static _parseCrtcState(data) {
        return {
            registers: Array.from(data.slice(0, 18)),
            vc: data[18], // Vertical counter
            sc: data[19], // Scan counter
            hc: data[20], // Horizontal counter
            ma: data[21] | (data[22] << 8), // Memory address
            maback: data[23] | (data[24] << 8), // Memory address backup
        };
    }

    /**
     * Parse B-Em Video state
     * @private
     * @param {Uint8Array} data - Video state data
     * @returns {Object} - jsbeeb Video state
     */
    static _parseVideoState(data) {
        return {
            scrx: data[0] | (data[1] << 8),
            scry: data[2] | (data[3] << 8),
            oddclock: data[4],
            vidclocks: data[5] | (data[6] << 8) | (data[7] << 16) | (data[8] << 24),
        };
    }

    /**
     * Parse B-Em Sound chip state
     * @private
     * @param {Uint8Array} data - Sound chip state data
     * @returns {Object} - jsbeeb Sound chip state
     */
    static _parseSoundState(data) {
        return {
            latch: Array.from(data.slice(0, 16)),
            count: Array.from(data.slice(16, 32)),
            stat: Array.from(data.slice(32, 48)),
            vol: Array.from(data.slice(48, 52)),
            noise: data[52],
            shift: data[53] | (data[54] << 8),
        };
    }

    /**
     * Create a section for B-Em snapshot file
     * @private
     * @param {string} key - Section key
     * @param {Uint8Array} data - Section data
     * @param {boolean} compressed - Whether data should be compressed
     * @returns {Uint8Array} - Section bytes
     */
    static _createSection(key, data, compressed = false) {
        const keyCode = key.charCodeAt(0) | (compressed ? 0x80 : 0);

        let header;
        if (compressed) {
            // 5-byte header: key (1) + size (4)
            header = new Uint8Array(5);
            header[0] = keyCode;
            header[1] = data.length & 0xff;
            header[2] = (data.length >> 8) & 0xff;
            header[3] = (data.length >> 16) & 0xff;
            header[4] = (data.length >> 24) & 0xff;
        } else {
            // 3-byte header: key (1) + size (2)
            header = new Uint8Array(3);
            header[0] = keyCode;
            header[1] = data.length & 0xff;
            header[2] = (data.length >> 8) & 0xff;
        }

        // Combine header and data
        const result = new Uint8Array(header.length + data.length);
        result.set(header, 0);
        result.set(data, header.length);

        return result;
    }

    /**
     * Create model section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createModelSection(saveState) {
        // Get model info from SaveState
        const bemModel = saveState.getComponent("bem_model");

        if (bemModel && bemModel.modelString) {
            // If we have bem_model from a converted snapshot, use it
            const modelData = new TextEncoder().encode(bemModel.modelString);
            const data = new Uint8Array(1 + modelData.length);
            data[0] = bemModel.model;
            data.set(modelData, 1);
            return this._createSection(BEM_SECTIONS.MODEL, data);
        }

        // Otherwise, try to determine BBC model from jsbeeb state
        // For now, just use BBC B as default
        const modelData = new TextEncoder().encode("BBC B w/8271+SWRAM");
        const data = new Uint8Array(1 + modelData.length);
        data[0] = 0; // Model 0 = BBC B
        data.set(modelData, 1);
        return this._createSection(BEM_SECTIONS.MODEL, data);
    }

    /**
     * Create CPU section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createCpuSection(saveState) {
        const cpuState = saveState.getComponent("cpu");
        if (!cpuState) return null;

        const data = new Uint8Array(13);

        // Set register values
        data[0] = cpuState.a;
        data[1] = cpuState.x;
        data[2] = cpuState.y;

        // Pack CPU flags
        // First load the flags
        const flags = new Flags();
        flags.loadState(cpuState.p);

        // Then pack them according to B-Em format
        let packedFlags = 0;
        if (flags.n) packedFlags |= 0x80;
        if (flags.v) packedFlags |= 0x40;
        packedFlags |= 0x20; // Bit 5 always set
        packedFlags |= 0x10; // B flag always set
        if (flags.d) packedFlags |= 0x08;
        if (flags.i) packedFlags |= 0x04;
        if (flags.z) packedFlags |= 0x02;
        if (flags.c) packedFlags |= 0x01;

        data[3] = packedFlags;
        data[4] = cpuState.s;
        data[5] = cpuState.pc & 0xff;
        data[6] = (cpuState.pc >> 8) & 0xff;
        data[7] = cpuState._nmiLevel ? 1 : 0; // nmi
        data[8] = cpuState.interrupt;

        // Cycles - we don't track the same way
        // Just use zeros for now
        data[9] = 0;
        data[10] = 0;
        data[11] = 0;
        data[12] = 0;

        return this._createSection(BEM_SECTIONS.CPU, data);
    }

    /**
     * Create memory section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createMemorySection(saveState) {
        // For this function, we'd need to compress memory using zlib
        // Since we don't have zlib in browser, we'll note this limitation

        saveState.metadata.conversionNote = "Memory export to B-Em format requires zlib compression";

        // For now, return null to indicate we can't create this section yet
        return null;
    }

    /**
     * Create System VIA section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createSysViaSection(saveState) {
        const viaState = saveState.getComponent("via_sys");
        const viaExtState = saveState.getComponent("sysvia_ext");

        if (!viaState) return null;

        // System VIA has 33 bytes: 32 for VIA + 1 for IC32
        const data = new Uint8Array(33);
        this._fillViaData(viaState, data);

        // Add IC32 if available
        if (viaExtState && viaExtState.IC32 !== undefined) {
            data[32] = viaExtState.IC32;
        } else {
            data[32] = 0; // Default value
        }

        return this._createSection(BEM_SECTIONS.SYSVIA, data);
    }

    /**
     * Create User VIA section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createUserViaSection(saveState) {
        const viaState = saveState.getComponent("via_user");

        if (!viaState) return null;

        // User VIA has 32 bytes
        const data = new Uint8Array(32);
        this._fillViaData(viaState, data);

        return this._createSection(BEM_SECTIONS.USERVIA, data);
    }

    /**
     * Fill VIA data in a buffer
     * @private
     * @param {Object} viaState - VIA state from saveState
     * @param {Uint8Array} data - Buffer to fill
     */
    static _fillViaData(viaState, data) {
        data[0] = viaState.ora;
        data[1] = viaState.orb;
        data[2] = viaState.ira;
        data[3] = viaState.irb;

        // Port A read values (not stored in jsbeeb)
        data[4] = viaState.ira; // Just duplicate IRA as port A read value
        data[5] = viaState.ira; // Just duplicate IRA as port A read value

        data[6] = viaState.ddra;
        data[7] = viaState.ddrb;
        data[8] = viaState.sr;
        data[9] = viaState.acr;
        data[10] = viaState.pcr;
        data[11] = viaState.ifr;
        data[12] = viaState.ier;

        // Timer values
        data[13] = viaState.t1l & 0xff;
        data[14] = (viaState.t1l >> 8) & 0xff;
        data[15] = (viaState.t1l >> 16) & 0xff;
        data[16] = (viaState.t1l >> 24) & 0xff;

        data[17] = viaState.t2l & 0xff;
        data[18] = (viaState.t2l >> 8) & 0xff;
        data[19] = (viaState.t2l >> 16) & 0xff;
        data[20] = (viaState.t2l >> 24) & 0xff;

        data[21] = viaState.t1c & 0xff;
        data[22] = (viaState.t1c >> 8) & 0xff;
        data[23] = (viaState.t1c >> 16) & 0xff;
        data[24] = (viaState.t1c >> 24) & 0xff;

        data[25] = viaState.t2c & 0xff;
        data[26] = (viaState.t2c >> 8) & 0xff;
        data[27] = (viaState.t2c >> 16) & 0xff;
        data[28] = (viaState.t2c >> 24) & 0xff;

        data[29] = viaState.t1hit;
        data[30] = viaState.t2hit;
        data[31] = viaState.ca1;
        // CA2, CB1, CB2 would be at 32, 33, 34, but B-Em only stores up to CA1
    }

    /**
     * Create Video ULA section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createVideoUlaSection(saveState) {
        const videoUla = saveState.getComponent("video_ula");

        if (!videoUla) return null;

        // Basic ULA is 17 bytes (control reg + 16 palette entries)
        // Full ULA with NuLA is 97 bytes
        let data;

        if (videoUla.nulaState) {
            // Create full ULA with NuLA state
            data = new Uint8Array(97);

            // Set control register and palette
            data[0] = videoUla.controlReg;
            data.set(videoUla.palette, 1);

            // Set NuLA palette (RGBA for 16 colors)
            for (let i = 0; i < 16; i++) {
                const color = videoUla.nulaState.palette[i];
                const offset = 17 + i * 4;
                data[offset] = color.r;
                data[offset + 1] = color.g;
                data[offset + 2] = color.b;
                data[offset + 3] = color.a;
            }

            // Set remaining NuLA state
            data[81] = videoUla.nulaState.writeFlag;
            data[82] = videoUla.nulaState.firstByte;
            data.set(videoUla.nulaState.flash, 83);
            data[91] = videoUla.nulaState.paletteMode;
            data[92] = videoUla.nulaState.horizontalOffset;
            data[93] = videoUla.nulaState.leftBlank;
            data[94] = videoUla.nulaState.disable;
            data[95] = videoUla.nulaState.attributeMode;
            data[96] = videoUla.nulaState.attributeText;
        } else {
            // Create basic ULA without NuLA
            data = new Uint8Array(17);
            data[0] = videoUla.controlReg;
            data.set(videoUla.palette, 1);
        }

        return this._createSection(BEM_SECTIONS.VIDEO_ULA, data);
    }

    /**
     * Create CRTC section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createCrtcSection(saveState) {
        const crtc = saveState.getComponent("crtc");

        if (!crtc) return null;

        const data = new Uint8Array(25);

        // Set registers
        data.set(crtc.registers, 0);

        // Set counters
        data[18] = crtc.vc;
        data[19] = crtc.sc;
        data[20] = crtc.hc;

        // Set memory addresses
        data[21] = crtc.ma & 0xff;
        data[22] = (crtc.ma >> 8) & 0xff;
        data[23] = crtc.maback & 0xff;
        data[24] = (crtc.maback >> 8) & 0xff;

        return this._createSection(BEM_SECTIONS.CRTC, data);
    }

    /**
     * Create Video section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createVideoSection(saveState) {
        const video = saveState.getComponent("video");

        if (!video) return null;

        const data = new Uint8Array(9);

        data[0] = video.scrx & 0xff;
        data[1] = (video.scrx >> 8) & 0xff;
        data[2] = video.scry & 0xff;
        data[3] = (video.scry >> 8) & 0xff;
        data[4] = video.oddclock;
        data[5] = video.vidclocks & 0xff;
        data[6] = (video.vidclocks >> 8) & 0xff;
        data[7] = (video.vidclocks >> 16) & 0xff;
        data[8] = (video.vidclocks >> 24) & 0xff;

        return this._createSection(BEM_SECTIONS.VIDEO, data);
    }

    /**
     * Create Sound section for B-Em snapshot
     * @private
     * @param {SaveState} saveState - jsbeeb SaveState
     * @returns {Uint8Array|null} - Section data or null if cannot be created
     */
    static _createSoundSection(saveState) {
        const sound = saveState.getComponent("sound");

        if (!sound) return null;

        const data = new Uint8Array(55);

        // Set latch, count and stat values (16 bytes each)
        data.set(sound.latch, 0);
        data.set(sound.count, 16);
        data.set(sound.stat, 32);

        // Set volume (4 bytes)
        data.set(sound.vol, 48);

        // Set noise and shift
        data[52] = sound.noise;
        data[53] = sound.shift & 0xff;
        data[54] = (sound.shift >> 8) & 0xff;

        return this._createSection(BEM_SECTIONS.SOUND, data);
    }
}

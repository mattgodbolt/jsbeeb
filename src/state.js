import * as utils from "./utils.js";
import * as disc from "./disc.js";
import { findModel } from "./models.js";

// Helper to convert Uint8Array to base64 string for JSON transport
function uint8ToB64(u8) {
    return btoa(utils.uint8ArrayToString(u8));
}

function b64ToUint8(s) {
    return utils.stringToUint8Array(atob(s));
}

/**
 * Create a snapshot of the emulator state. Returns a Blob that can be downloaded.
 * Captures CPU registers, memory, simple peripheral blobs (discs, filestore, mmc, cmos)
 * @param {Cpu6502} processor
 * @returns {Promise<Blob>} blob
 */
export async function saveState(processor) {
    const state = {};

    // Core CPU registers
    state.cpu = {
        a: processor.a,
        x: processor.x,
        y: processor.y,
        s: processor.s,
        pc: processor.pc,
        p: processor.p.asByte(),
        romsel: processor.romsel,
        acccon: processor.acccon,
    };

    // Memory - serialise only the RAM/ROM buffer (largest) as base64
    state.ramRomOs = uint8ToB64(processor.ramRomOs);
    state.memStat = uint8ToB64(processor.memStat);
    // memLook is Int32Array; convert to regular array
    state.memLook = Array.prototype.slice.call(processor.memLook);

    // Old PC/A/X/Y history
    state.oldPcArray = Array.prototype.slice.call(processor.oldPcArray);
    state.oldAArray = Array.prototype.slice.call(processor.oldAArray);
    state.oldXArray = Array.prototype.slice.call(processor.oldXArray);
    state.oldYArray = Array.prototype.slice.call(processor.oldYArray);

    // Video state
    state.videoDisplayPage = processor.videoDisplayPage;

    // FDC drives - serialize current disc images if possible
    state.discs = [];
    try {
        for (let i = 0; i < processor.fdc.drives.length; ++i) {
            const d = processor.fdc.drives[i].disc;
            if (!d) {
                state.discs.push(null);
                continue;
            }
            // Try to guess disc type and use saver
            const discType = disc.guessDiscTypeFromName(d.name || "disk.ssd");
            if (discType && discType.saver) {
                try {
                    const data = discType.saver(d);
                    state.discs.push({ name: d.name, data: uint8ToB64(data), extension: discType.extension });
                } catch (e) {
                    console.warn("Failed to saver disc", e);
                    state.discs.push({ name: d.name, data: null, extension: null });
                }
            } else {
                state.discs.push({ name: d.name, data: null, extension: null });
            }
        }
    } catch (e) {
        console.warn("Error serialising discs:", e);
    }

    // Filestore / SCSI
    try {
        if (processor.filestore && processor.filestore.scsi) {
            state.filestore = uint8ToB64(processor.filestore.scsi);
        }
    } catch (e) {
        console.warn("state: filestore serialise error", e);
    }

    // ATOM MMC
    try {
        if (processor.atommc && processor.atommc.GetMMCData) {
            const u = processor.atommc.GetMMCData();
            // u is array of WFNFiles - for very large arrays, serialize each entry individually to avoid string size limits
            // Each entry is JSON-stringified, encoded as Uint8Array, then base64-encoded
            state.mmc = u.map((entry) => {
                // display the name and the size of the entry
                if (!entry) return null;
                const path = entry.path || "unnamed";
                const dataU8 = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data || []);
                if (dataU8 && dataU8.length) {
                    console.log(`state: MMC entry "${path}" size ${dataU8.length}`);
                }
                // Store a small JSON object where the data is base64 encoded so JSON.stringify
                // round-trips cleanly across save/restore.
                const obj = { path: path, data: uint8ToB64(dataU8) };
                const jsonStr = JSON.stringify(obj);
                const u8 = utils.stringToUint8Array(jsonStr);
                return uint8ToB64(u8);
            });
        }
    } catch (e) {
        console.warn("state: atommc serialise error", e);
    }

    // CMOS contents
    try {
        if (processor.cmos && processor.cmos.store) state.cmos = Array.prototype.slice.call(processor.cmos.store);
    } catch (e) {
        console.warn("state: cmos serialise error", e);
    }

    // Scheduler epoch
    try {
        if (processor.scheduler) state.scheduler = { epoch: processor.scheduler.epoch };
    } catch (e) {
        console.warn("state: scheduler serialise error", e);
    }

    // VIA (sysvia and uservia)
    try {
        if (processor.sysvia) {
            const v = processor.sysvia;
            const sys = {
                ora: v.ora,
                orb: v.orb,
                ira: v.ira,
                irb: v.irb,
                ddra: v.ddra,
                ddrb: v.ddrb,
                sr: v.sr,
                t1l: v.t1l,
                t2l: v.t2l,
                t1c: v.t1c,
                t2c: v.t2c,
                acr: v.acr,
                pcr: v.pcr,
                ifr: v.ifr,
                ier: v.ier,
                t1hit: v.t1hit,
                t2hit: v.t2hit,
                portapins: v.portapins,
                portbpins: v.portbpins,
                ca1: v.ca1,
                ca2: v.ca2,
                cb1: v.cb1,
                cb2: v.cb2,
                justhit: v.justhit,
                t1_pb7: v.t1_pb7,
                lastPolltime: v.lastPolltime,
                // keys: array of arrays
                keys: Array.prototype.map.call(v.keys, (k) => Array.prototype.slice.call(k)),
            };
            // task scheduling
            try {
                sys.taskExpireEpoch = v.task && v.task.scheduled() ? v.task.expireEpoch : null;
            } catch (e) {
                console.warn("state: sysvia task scheduling read error", e);
            }
            state.sysvia = sys;
        }
        if (processor.uservia) {
            const v = processor.uservia;
            const usr = {
                ora: v.ora,
                orb: v.orb,
                ira: v.ira,
                irb: v.irb,
                ddra: v.ddra,
                ddrb: v.ddrb,
                sr: v.sr,
                t1l: v.t1l,
                t2l: v.t2l,
                t1c: v.t1c,
                t2c: v.t2c,
                acr: v.acr,
                pcr: v.pcr,
                ifr: v.ifr,
                ier: v.ier,
                t1hit: v.t1hit,
                t2hit: v.t2hit,
                portapins: v.portapins,
                portbpins: v.portbpins,
                ca1: v.ca1,
                ca2: v.ca2,
                cb1: v.cb1,
                cb2: v.cb2,
                justhit: v.justhit,
                t1_pb7: v.t1_pb7,
                lastPolltime: v.lastPolltime,
            };
            try {
                usr.taskExpireEpoch = v.task && v.task.scheduled() ? v.task.expireEpoch : null;
            } catch (e) {
                console.warn("state: uservia task scheduling read error", e);
            }
            state.uservia = usr;
        }
    } catch (e) {
        console.warn("state: via serialise error", e);
    }

    // Teletext (video.teletext)
    try {
        if (processor.video && processor.video.teletext) {
            const t = processor.video.teletext;
            state.teletext = {
                prevCol: t.prevCol,
                col: t.col,
                bg: t.bg,
                sep: t.sep,
                dbl: t.dbl,
                oldDbl: t.oldDbl,
                secondHalfOfDouble: t.secondHalfOfDouble,
                wasDbl: t.wasDbl,
                gfx: t.gfx,
                flash: t.flash,
                flashOn: t.flashOn,
                flashTime: t.flashTime,
                heldChar: t.heldChar,
                holdChar: t.holdChar,
                dataQueue: Array.prototype.slice.call(t.dataQueue),
                scanlineCounter: t.scanlineCounter,
                levelDEW: !!t.levelDEW,
                levelDISPTMG: !!t.levelDISPTMG,
                levelRA0: !!t.levelRA0,
            };
        }
    } catch (e) {
        console.warn("state: teletext serialise error", e);
    }

    // Atom PPIA (keyboard, tape, speaker)
    try {
        if (processor.atomppia) {
            const p = processor.atomppia;
            state.atomppia = {
                latcha: p.latcha,
                latchb: p.latchb,
                latchc: p.latchc,
                portapins: p.portapins,
                portbpins: p.portbpins,
                portcpins: p.portcpins,
                creg: p.creg,
                prevcas: p.prevcas,
                keyboardEnabled: !!p.keyboardEnabled,
                lastTime: p.lastTime || 0,
                tapeCarrierCount: p.tapeCarrierCount | 0,
                tapeDcdLineLevel: !!p.tapeDcdLineLevel,
                // keys: array of Uint8Array -> arrays
                keys: p.keys ? p.keys.map((k) => Array.prototype.slice.call(k)) : null,
            };
        }
    } catch (e) {
        console.warn("state: atomppia serialise error", e);
    }

    // 6847 video chip runtime state (video.video6847)
    try {
        if (processor.video && processor.video.video6847) {
            const v = processor.video.video6847;
            state.video6847 = {
                regs: Array.prototype.slice.call(v.regs || []),
                bitmapX: v.bitmapX | 0,
                bitmapY: v.bitmapY | 0,
                frameCount: v.frameCount | 0,
                inHSync: !!v.inHSync,
                inVSync: !!v.inVSync,
                doubledScanlines: !!v.doubledScanlines,
                interlacedSyncAndVideo: !!v.interlacedSyncAndVideo,
                horizCounter: v.horizCounter | 0,
                vertCounter: v.vertCounter | 0,
                scanlineCounter: v.scanlineCounter | 0,
                addr: v.addr | 0,
                lineStartAddr: v.lineStartAddr | 0,
                nextLineStartAddr: v.nextLineStartAddr | 0,
                pixelsPerChar: v.pixelsPerChar | 0,
                bitmapPxPerPixel: v.bitmapPxPerPixel | 0,
                pixelsPerBit: v.pixelsPerBit | 0,
                bpp: v.bpp | 0,
                cpuAddr: v.cpuAddr | 0,
                // lastmode is an internal cache used to avoid recomputing the mode;
                // don't persist it so we always recompute mode on restore.
                vdg_cycles: v.vdg_cycles | 0,
                charTime: v.charTime | 0,
                bordercolour: v.bordercolour | 0,
                dispEnabled: v.dispEnabled | 0,
            };
        }
    } catch (e) {
        console.warn("state: video6847 serialise error", e);
    }

    // ACIA
    try {
        if (processor.acia) {
            const a = processor.acia;
            const ac = {
                sr: a.sr,
                cr: a.cr,
                dr: a.dr,
                rs423Selected: a.rs423Selected,
                motorOn: a.motorOn,
                tapeCarrierCount: a.tapeCarrierCount,
                tapeDcdLineLevel: a.tapeDcdLineLevel,
                hadDcdHigh: a.hadDcdHigh,
                serialReceiveRate: a.serialReceiveRate,
                serialReceiveCyclesPerByte: a.serialReceiveCyclesPerByte,
            };
            try {
                ac.txCompleteExpire =
                    a.txCompleteTask && a.txCompleteTask.scheduled() ? a.txCompleteTask.expireEpoch : null;
            } catch (e) {
                console.warn("state: acia txComplete task read error", e);
            }
            try {
                ac.runTapeExpire = a.runTapeTask && a.runTapeTask.scheduled() ? a.runTapeTask.expireEpoch : null;
            } catch (e) {
                console.warn("state: acia runTape task read error", e);
            }
            try {
                ac.runRs423Expire = a.runRs423Task && a.runRs423Task.scheduled() ? a.runRs423Task.expireEpoch : null;
            } catch (e) {
                console.warn("state: acia runRs423 task read error", e);
            }
            state.acia = ac;
        }
    } catch (e) {
        console.warn("state: acia serialise error", e);
    }

    // FDC internal registers (if present)
    try {
        if (processor.fdc) {
            const f = processor.fdc;
            const fdcState = {};
            if (f._regs) fdcState.regs = Array.prototype.slice.call(f._regs);
            if (f._state !== undefined) fdcState.state = f._state;
            if (f._stateCount !== undefined) fdcState.stateCount = f._stateCount;
            if (f._mmioData !== undefined) fdcState.mmioData = f._mmioData;
            state.fdc = fdcState;
        }
    } catch (e) {
        console.warn("state: fdc serialise error", e);
    }

    // Minimal VIA/ACIA/Econet state could be extended here.

    // Model (name)
    try {
        if (processor.model && processor.model.name) state.model = processor.model.name;
    } catch (e) {
        console.warn("state: model serialise error", e);
    }

    // Video-level flags (teletext/ULA)
    try {
        if (processor.video) {
            state.video = state.video || {};
            state.video.teletextMode = !!processor.video.teletextMode;
            state.video.ulactrl = processor.video.ulactrl | 0;
            state.video.ulaMode = processor.video.ulaMode | 0;
            state.video.pixelsPerChar = processor.video.pixelsPerChar | 0;
        }
    } catch (e) {
        console.warn("state: video serialise error", e);
    }

    const json = JSON.stringify({ version: 1, state });
    const blob = new Blob([json], { type: "application/json" });
    return blob;
}

/**
 * Restore a snapshot created by saveState.
 * @param {Cpu6502} processor
 * @param {Object} jsonObj Parsed JSON object from the state blob
 */
export async function restoreState(processor, jsonObj) {
    const obj = jsonObj && jsonObj.state ? jsonObj.state : jsonObj;
    // Restore model if present. We map by name using findModel to obtain the Model object.
    try {
        if (obj.model) {
            const m = findModel(obj.model);
            if (m) {
                processor.model = m;
                // Mirror some of the flags that main.js sets when a model is chosen
                processor.model.isAtom =
                    processor.model.synonyms && processor.model.synonyms[0]
                        ? processor.model.synonyms[0].slice(0, 4) === "Atom"
                        : false;
                if (processor.model.isAtom) {
                    processor.model.useMMC = processor.model.name.includes("(MMC)");
                    processor.model.useFdc = processor.model.name.includes("(DOS)");
                }
            } else {
                console.warn("state: unknown model name stored in snapshot:", obj.model);
            }
        }
    } catch (e) {
        console.warn("state: model restore error", e);
    }

    if (obj.cpu) {
        processor.a = obj.cpu.a | 0;
        processor.x = obj.cpu.x | 0;
        processor.y = obj.cpu.y | 0;
        processor.s = obj.cpu.s | 0;
        processor.pc = obj.cpu.pc | 0;
        if (processor.p && processor.p.setFromByte) processor.p.setFromByte(obj.cpu.p);
        if (obj.cpu.romsel !== undefined) processor.romsel = obj.cpu.romsel;
        if (obj.cpu.acccon !== undefined) processor.acccon = obj.cpu.acccon;
    }

    // Memory
    try {
        if (obj.ramRomOs) {
            const arr = b64ToUint8(obj.ramRomOs);
            // Ensure we don't blow up: copy into existing buffer length
            const len = Math.min(arr.length, processor.ramRomOs.length);
            processor.ramRomOs.set(arr.subarray(0, len));
        }
        if (obj.memStat) {
            const ms = b64ToUint8(obj.memStat);
            processor.memStat.set(ms.subarray(0, processor.memStat.length));
        }
        if (obj.memLook) {
            // memLook is Int32Array - copy as possible
            for (let i = 0; i < Math.min(processor.memLook.length, obj.memLook.length); ++i) {
                processor.memLook[i] = obj.memLook[i] | 0;
            }
        }
    } catch (e) {
        console.warn("Error restoring memory:", e);
    }

    // Old PC/A/X/Y
    try {
        if (obj.oldPcArray) processor.oldPcArray.set(obj.oldPcArray.slice(0, processor.oldPcArray.length));
        if (obj.oldAArray) processor.oldAArray.set(obj.oldAArray.slice(0, processor.oldAArray.length));
        if (obj.oldXArray) processor.oldXArray.set(obj.oldXArray.slice(0, processor.oldXArray.length));
        if (obj.oldYArray) processor.oldYArray.set(obj.oldYArray.slice(0, processor.oldYArray.length));
    } catch (e) {
        console.warn("state: restoring old PC/A/X/Y failed", e);
    }

    if (obj.videoDisplayPage !== undefined) processor.videoDisplayPage = obj.videoDisplayPage;

    // Restore discs
    try {
        if (obj.discs && processor.fdc && processor.fdc.drives) {
            for (let i = 0; i < Math.min(obj.discs.length, processor.fdc.drives.length); ++i) {
                const d = obj.discs[i];
                if (!d) continue;
                if (d.data) {
                    const u8 = b64ToUint8(d.data);
                    // Use disc.discFor to create a Disc object
                    try {
                        const discObj = disc.discFor(processor.fdc, d.name || "disk.ssd", u8);
                        processor.fdc.loadDisc(i, discObj);
                    } catch (e) {
                        console.warn("Failed to restore disc", e);
                    }
                }
            }
        }
    } catch (e) {
        console.warn("Error restoring discs:", e);
    }

    // Filestore
    try {
        if (obj.filestore && processor.filestore) processor.filestore.scsi = b64ToUint8(obj.filestore);
    } catch (e) {
        console.warn("state: filestore restore error", e);
    }

    // MMC
    try {
        if (obj.mmc && processor.atommc && processor.atommc.SetMMCData) {
            // obj.mmc is an array of base64-encoded entries, each representing a WFNFile
            let u = [];
            try {
                if (Array.isArray(obj.mmc)) {
                    u = obj.mmc.map((entry) => {
                        if (!entry) return null;
                        try {
                            const u8 = b64ToUint8(entry);
                            const jsonStr = utils.uint8ArrayToString(u8);
                            const parsed = JSON.parse(jsonStr);
                            // Expect parsed to have { path: string, data: base64 }
                            if (parsed && parsed.path && typeof parsed.data === "string") {
                                try {
                                    const dataU8 = b64ToUint8(parsed.data);
                                    console.log(`state: Restoring MMC entry "${parsed.path}" size ${dataU8.length}`);
                                    return { path: parsed.path, data: dataU8 };
                                } catch (e) {
                                    console.warn("state: MMC entry data base64 decode failed", e);
                                }
                            }
                            return null;
                        } catch (e) {
                            console.warn("state: MMC entry decode error", e);
                            return null;
                        }
                    });
                }
            } catch (e) {
                console.warn("state: MMC restore decode error", e);
                u = [];
            }
            processor.atommc.SetMMCData(u);
        }
    } catch (e) {
        console.warn("state: MMC restore error", e);
    }

    // CMOS
    try {
        if (obj.cmos && processor.cmos && processor.cmos.store) {
            processor.cmos.store = obj.cmos.slice(0, processor.cmos.store.length);
            processor.cmos.save();
        }
    } catch (e) {
        console.warn("state: CMOS restore error", e);
    }

    // Some devices may need a reset to pick up the new state or coroutine scheduling.
    try {
        if (processor.fdc && processor.fdc.reset) processor.fdc.reset();
    } catch (e) {
        console.warn("state: fdc reset error", e);
    }

    // Restore scheduler epoch and reschedule tasks where we saved absolute expireEpochs
    try {
        if (obj.scheduler && processor.scheduler) {
            const sched = processor.scheduler;
            sched.epoch = obj.scheduler.epoch | 0;
        }
    } catch (e) {
        console.warn("state: scheduler restore error", e);
    }

    try {
        if (obj.sysvia && processor.sysvia) {
            const v = processor.sysvia;
            const s = obj.sysvia;
            v.ora = s.ora | 0;
            v.orb = s.orb | 0;
            v.ira = s.ira | 0;
            v.irb = s.irb | 0;
            v.ddra = s.ddra | 0;
            v.ddrb = s.ddrb | 0;
            v.sr = s.sr | 0;
            v.t1l = s.t1l | 0;
            v.t2l = s.t2l | 0;
            v.t1c = s.t1c | 0;
            v.t2c = s.t2c | 0;
            v.acr = s.acr | 0;
            v.pcr = s.pcr | 0;
            v.ifr = s.ifr | 0;
            v.ier = s.ier | 0;
            v.t1hit = !!s.t1hit;
            v.t2hit = !!s.t2hit;
            v.portapins = s.portapins | 0;
            v.portbpins = s.portbpins | 0;
            v.ca1 = !!s.ca1;
            v.ca2 = !!s.ca2;
            v.cb1 = !!s.cb1;
            v.cb2 = !!s.cb2;
            v.justhit = s.justhit | 0;
            v.t1_pb7 = s.t1_pb7 | 0;
            v.lastPolltime = s.lastPolltime | 0;
            if (s.keys) {
                try {
                    for (let i = 0; i < Math.min(v.keys.length, s.keys.length); ++i) {
                        v.keys[i].set(s.keys[i].slice(0, v.keys[i].length));
                    }
                } catch (e) {
                    console.warn("state: sysvia keys restore error", e);
                }
            }
            if (s.taskExpireEpoch && v.task) {
                try {
                    v.task.reschedule(Math.max(1, s.taskExpireEpoch - processor.scheduler.epoch));
                } catch (e) {
                    console.warn("state: sysvia task reschedule error", e);
                }
            }
        }
    } catch (e) {
        console.warn("state: sysvia restore error", e);
    }

    try {
        if (obj.uservia && processor.uservia) {
            const v = processor.uservia;
            const s = obj.uservia;
            v.ora = s.ora | 0;
            v.orb = s.orb | 0;
            v.ira = s.ira | 0;
            v.irb = s.irb | 0;
            v.ddra = s.ddra | 0;
            v.ddrb = s.ddrb | 0;
            v.sr = s.sr | 0;
            v.t1l = s.t1l | 0;
            v.t2l = s.t2l | 0;
            v.t1c = s.t1c | 0;
            v.t2c = s.t2c | 0;
            v.acr = s.acr | 0;
            v.pcr = s.pcr | 0;
            v.ifr = s.ifr | 0;
            v.ier = s.ier | 0;
            v.t1hit = !!s.t1hit;
            v.t2hit = !!s.t2hit;
            v.portapins = s.portapins | 0;
            v.portbpins = s.portbpins | 0;
            v.ca1 = !!s.ca1;
            v.ca2 = !!s.ca2;
            v.cb1 = !!s.cb1;
            v.cb2 = !!s.cb2;
            v.justhit = s.justhit | 0;
            v.t1_pb7 = s.t1_pb7 | 0;
            v.lastPolltime = s.lastPolltime | 0;
            if (s.taskExpireEpoch && v.task) {
                try {
                    v.task.reschedule(Math.max(1, s.taskExpireEpoch - processor.scheduler.epoch));
                } catch (e) {
                    console.warn("state: uservia task reschedule error", e);
                }
            }
        }
    } catch (e) {
        console.warn("state: uservia restore error", e);
    }

    // Restore teletext
    try {
        if (obj.teletext && processor.video && processor.video.teletext) {
            const t = processor.video.teletext;
            const s = obj.teletext;
            if (s.prevCol !== undefined) t.prevCol = s.prevCol | 0;
            if (s.col !== undefined) t.col = s.col | 0;
            if (s.bg !== undefined) t.bg = s.bg | 0;
            if (s.sep !== undefined) t.sep = !!s.sep;
            if (s.dbl !== undefined) t.dbl = !!s.dbl;
            if (s.oldDbl !== undefined) t.oldDbl = !!s.oldDbl;
            if (s.secondHalfOfDouble !== undefined) t.secondHalfOfDouble = !!s.secondHalfOfDouble;
            if (s.wasDbl !== undefined) t.wasDbl = !!s.wasDbl;
            if (s.gfx !== undefined) t.gfx = !!s.gfx;
            if (s.flash !== undefined) t.flash = !!s.flash;
            if (s.flashOn !== undefined) t.flashOn = !!s.flashOn;
            if (s.flashTime !== undefined) t.flashTime = s.flashTime | 0;
            if (s.heldChar !== undefined) t.heldChar = s.heldChar | 0;
            if (s.holdChar !== undefined) t.holdChar = !!s.holdChar;
            if (s.dataQueue && Array.isArray(s.dataQueue) && t.dataQueue) {
                for (let i = 0; i < Math.min(t.dataQueue.length, s.dataQueue.length); ++i)
                    t.dataQueue[i] = s.dataQueue[i] | 0;
            }
            if (s.scanlineCounter !== undefined) t.scanlineCounter = s.scanlineCounter | 0;
            if (s.levelDEW !== undefined) t.levelDEW = !!s.levelDEW;
            if (s.levelDISPTMG !== undefined) t.levelDISPTMG = !!s.levelDISPTMG;
            if (s.levelRA0 !== undefined) t.levelRA0 = !!s.levelRA0;
        }
    } catch (e) {
        console.warn("state: teletext restore error", e);
    }

    // Restore top-level video flags
    try {
        if (obj.video && processor.video) {
            const sv = obj.video;
            const pv = processor.video;
            if (sv.teletextMode !== undefined) pv.teletextMode = !!sv.teletextMode;
            if (sv.ulactrl !== undefined) pv.ulactrl = sv.ulactrl | 0;
            if (sv.ulaMode !== undefined) pv.ulaMode = sv.ulaMode | 0;
            if (sv.pixelsPerChar !== undefined) pv.pixelsPerChar = sv.pixelsPerChar | 0;
        }
    } catch (e) {
        console.warn("state: video restore error", e);
    }

    // Restore Atom PPIA
    try {
        if (obj.atomppia && processor.atomppia) {
            const p = processor.atomppia;
            const s = obj.atomppia;
            if (s.latcha !== undefined) p.latcha = s.latcha | 0;
            if (s.latchb !== undefined) p.latchb = s.latchb | 0;
            if (s.latchc !== undefined) p.latchc = s.latchc | 0;
            if (s.portapins !== undefined) p.portapins = s.portapins | 0;
            if (s.portbpins !== undefined) p.portbpins = s.portbpins | 0;
            if (s.portcpins !== undefined) p.portcpins = s.portcpins | 0;
            if (s.creg !== undefined) p.creg = s.creg | 0;
            if (s.prevcas !== undefined) p.prevcas = s.prevcas | 0;
            if (s.keyboardEnabled !== undefined) p.keyboardEnabled = !!s.keyboardEnabled;
            if (s.lastTime !== undefined) p.lastTime = s.lastTime;
            if (s.tapeCarrierCount !== undefined) p.tapeCarrierCount = s.tapeCarrierCount | 0;
            if (s.tapeDcdLineLevel !== undefined) p.tapeDcdLineLevel = !!s.tapeDcdLineLevel;
            if (s.keys && Array.isArray(s.keys) && p.keys) {
                try {
                    for (let i = 0; i < Math.min(p.keys.length, s.keys.length); ++i) {
                        p.keys[i].set(s.keys[i].slice(0, p.keys[i].length));
                    }
                } catch (e) {
                    console.warn("state: atomppia keys restore error", e);
                }
            }
            // Recalculate port pin derived values (and trigger any side-effects)
            try {
                if (typeof p.recalculatePortAPins === "function") p.recalculatePortAPins();
                if (typeof p.recalculatePortBPins === "function") p.recalculatePortBPins();
                if (typeof p.recalculatePortCPins === "function") p.recalculatePortCPins();
            } catch (e) {
                console.warn("state: atomppia recalc pins error", e);
            }
        }
    } catch (e) {
        console.warn("state: atomppia restore error", e);
    }

    // Restore 6847 video chip state
    try {
        if (obj.video6847 && processor.video && processor.video.video6847) {
            const v = processor.video.video6847;
            const s = obj.video6847;
            if (s.regs && v.regs) {
                for (let i = 0; i < Math.min(v.regs.length, s.regs.length); ++i) v.regs[i] = s.regs[i] | 0;
            }
            if (s.bitmapX !== undefined) v.bitmapX = s.bitmapX | 0;
            if (s.bitmapY !== undefined) v.bitmapY = s.bitmapY | 0;
            if (s.frameCount !== undefined) v.frameCount = s.frameCount | 0;
            if (s.inHSync !== undefined) v.inHSync = !!s.inHSync;
            if (s.inVSync !== undefined) v.inVSync = !!s.inVSync;
            if (s.doubledScanlines !== undefined) v.doubledScanlines = !!s.doubledScanlines;
            if (s.interlacedSyncAndVideo !== undefined) v.interlacedSyncAndVideo = !!s.interlacedSyncAndVideo;
            if (s.horizCounter !== undefined) v.horizCounter = s.horizCounter | 0;
            if (s.vertCounter !== undefined) v.vertCounter = s.vertCounter | 0;
            if (s.scanlineCounter !== undefined) v.scanlineCounter = s.scanlineCounter | 0;
            if (s.addr !== undefined) v.addr = s.addr | 0;
            if (s.lineStartAddr !== undefined) v.lineStartAddr = s.lineStartAddr | 0;
            if (s.nextLineStartAddr !== undefined) v.nextLineStartAddr = s.nextLineStartAddr | 0;
            if (s.pixelsPerChar !== undefined) v.pixelsPerChar = s.pixelsPerChar | 0;
            if (s.bitmapPxPerPixel !== undefined) v.bitmapPxPerPixel = s.bitmapPxPerPixel | 0;
            if (s.pixelsPerBit !== undefined) v.pixelsPerBit = s.pixelsPerBit | 0;
            if (s.bpp !== undefined) v.bpp = s.bpp | 0;
            if (s.cpuAddr !== undefined) v.cpuAddr = s.cpuAddr | 0;
            // Do not restore lastmode from the saved state: clear it so setValuesFromMode
            // will recompute derived mode fields during restore.
            if (s.lastmode !== undefined) {
                try {
                    v.lastmode = undefined;
                } catch (e) {
                    console.warn("state: unable to undefine lastnmode", e);
                    v.lastmode = null;
                }
            }
            if (s.vdg_cycles !== undefined) v.vdg_cycles = s.vdg_cycles | 0;
            if (s.charTime !== undefined) v.charTime = s.charTime | 0;
            if (s.bordercolour !== undefined) v.bordercolour = s.bordercolour | 0;
            if (s.dispEnabled !== undefined) v.dispEnabled = s.dispEnabled | 0;
            // Recompute derived mode fields from the PPIA port pins and sync paint buffer
            try {
                const modeFromPpia = v.ppia ? v.ppia.portapins : processor.atomppia ? processor.atomppia.portapins : 0;
                v.setValuesFromMode(modeFromPpia);
            } catch (e) {
                // ignore if setValuesFromMode isn't present or fails
                console.warn("state: setValuesFromMode not present or failed error", e);
            }
            try {
                if (v.clearPaintBuffer) v.clearPaintBuffer();
            } catch (e) {
                console.warn("state: video6847 clearPaintBuffer error", e);
            }
            // Sync top-level video rendering flags so the Video renderer uses the same parameters
            try {
                if (processor.video) {
                    processor.video.pixelsPerChar = v.pixelsPerChar | 0;
                    processor.video.bitmapX = v.bitmapX | 0;
                    processor.video.bitmapY = v.bitmapY | 0;
                    processor.video.doubledScanlines = !!v.doubledScanlines;
                    processor.video.interlacedSyncAndVideo = !!v.interlacedSyncAndVideo;
                    processor.video.pixelsPerChar = v.pixelsPerChar | 0;
                    // Also ensure per-pixel scaling matches
                    processor.video.bitmapPxPerPixel = v.bitmapPxPerPixel | 0;
                    processor.video.pixelsPerChar = v.pixelsPerChar | 0;
                }
            } catch (e) {
                console.warn("state: sync video flags error", e);
            }
        }
    } catch (e) {
        console.warn("state: video6847 restore error", e);
    }

    try {
        if (obj.acia && processor.acia) {
            const a = processor.acia;
            const s = obj.acia;
            a.sr = s.sr | 0;
            a.cr = s.cr | 0;
            a.dr = s.dr | 0;
            a.rs423Selected = !!s.rs423Selected;
            a.motorOn = !!s.motorOn;
            a.tapeCarrierCount = s.tapeCarrierCount | 0;
            a.tapeDcdLineLevel = !!s.tapeDcdLineLevel;
            a.hadDcdHigh = !!s.hadDcdHigh;
            a.serialReceiveRate = s.serialReceiveRate | 0;
            a.serialReceiveCyclesPerByte = s.serialReceiveCyclesPerByte | 0;
            try {
                if (s.txCompleteExpire && a.txCompleteTask)
                    a.txCompleteTask.reschedule(Math.max(1, s.txCompleteExpire - processor.scheduler.epoch));
            } catch (e) {
                console.warn("state: acia txComplete reschedule error", e);
            }
            try {
                if (s.runTapeExpire && a.runTapeTask)
                    a.runTapeTask.reschedule(Math.max(1, s.runTapeExpire - processor.scheduler.epoch));
            } catch (e) {
                console.warn("state: acia runTape reschedule error", e);
            }
            try {
                if (s.runRs423Expire && a.runRs423Task)
                    a.runRs423Task.reschedule(Math.max(1, s.runRs423Expire - processor.scheduler.epoch));
            } catch (e) {
                console.warn("state: acia runRs423 reschedule error", e);
            }
        }
    } catch (e) {
        console.warn("state: acia restore error", e);
    }

    try {
        if (obj.fdc && processor.fdc) {
            const f = processor.fdc;
            const s = obj.fdc;
            if (s.regs && f._regs) {
                for (let i = 0; i < Math.min(f._regs.length, s.regs.length); ++i) f._regs[i] = s.regs[i] | 0;
            }
            if (s.state !== undefined) f._state = s.state;
            if (s.stateCount !== undefined) f._stateCount = s.stateCount;
            if (s.mmioData !== undefined) f._mmioData = s.mmioData;
        }
    } catch (e) {
        console.warn("state: fdc restore error", e);
    }

    return true;
}

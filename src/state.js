import * as utils from "./utils.js";
import * as disc from "./disc.js";

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
            const mmcdata = processor.atommc.GetMMCData();
            // mmcdata may be an Array/Uint8Array
            state.mmc = uint8ToB64(new Uint8Array(mmcdata));
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
            const u = b64ToUint8(obj.mmc);
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

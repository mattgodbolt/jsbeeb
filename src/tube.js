import { hexbyte, hexword } from "./hex.js";

//  this one should be declared more globally
const HOST_CPU_FLAG_IRQ_TUBE_ULA = 8;

const TUBE_ULA_R1 = 0;
const TUBE_ULA_R2 = 1;
const TUBE_ULA_R3 = 2;
const TUBE_ULA_R4 = 3;
const TUBE_ULA_R1_STATUS_ADDRESS = 0;
const TUBE_ULA_R1_DATA_ADDRESS = 1;
const TUBE_ULA_R2_STATUS_ADDRESS = 2;
const TUBE_ULA_R2_DATA_ADDRESS = 3;
const TUBE_ULA_R3_STATUS_ADDRESS = 4;
const TUBE_ULA_R3_DATA_ADDRESS = 5;
const TUBE_ULA_R4_STATUS_ADDRESS = 6;
const TUBE_ULA_R4_DATA_ADDRESS = 7;
const TUBE_ULA_FLAG_DATA_AVAILABLE = 0x80;
const TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL = 0x40;
const TUBE_ULA_FLAG_STATUS_Q = 0x01;
const TUBE_ULA_FLAG_STATUS_I = 0x02;
const TUBE_ULA_FLAG_STATUS_J = 0x04;
const TUBE_ULA_FLAG_STATUS_M = 0x08;
const TUBE_ULA_FLAG_STATUS_V = 0x10;
const TUBE_ULA_FLAG_STATUS_P = 0x20;
const TUBE_ULA_FLAG_STATUS_T = 0x40;
const TUBE_ULA_FLAG_STATUS_S = 0x80;
//  human-readable aliases for the above flags
const TUBE_ULA_FLAG_STATUS_ENABLE_HOST_IRQ_FROM_R4_DATA = TUBE_ULA_FLAG_STATUS_Q;
const TUBE_ULA_FLAG_STATUS_ENABLE_PARASITE_IRQ_FROM_R1_DATA = TUBE_ULA_FLAG_STATUS_I;
const TUBE_ULA_FLAG_STATUS_ENABLE_PARASITE_IRQ_FROM_R4_DATA = TUBE_ULA_FLAG_STATUS_J;
const TUBE_ULA_FLAG_STATUS_ENABLE_PARASITE_NMI_FROM_R3_DATA = TUBE_ULA_FLAG_STATUS_M;
const TUBE_ULA_FLAG_STATUS_ENABLE_2_BYTE_R3_DATA = TUBE_ULA_FLAG_STATUS_V;
const TUBE_ULA_FLAG_STATUS_PARASITE_RESET_ACTIVE_LOW = TUBE_ULA_FLAG_STATUS_P;
const TUBE_ULA_FLAG_STATUS_CLEAR_ALL_TUBE_REGISTERS = TUBE_ULA_FLAG_STATUS_T;
const TUBE_ULA_FLAG_STATUS_SET_CONTROL_FLAGS = TUBE_ULA_FLAG_STATUS_S;
const TUBE_ULA_R1_PARASITE_BYTE_COUNT = 24;
//  the control flags live in the bottom six bits of the register 1 status registers, which both
//  sides see merged with their own flow control bits
const TUBE_ULA_CONTROL_FLAG_MASK = 0x3f;
//  every status register except register 1's reads its unused bits as ones
const TUBE_ULA_STATUS_UNUSED_BITS = 0x3f;

export class Tube {
    constructor(hostCpu, parasiteCpu) {
        this.hostCpu = hostCpu;
        this.parasiteCpu = parasiteCpu;
        this.internalStatusRegister = 0;
        this.hostStatus = new Uint8Array(4);
        this.parasiteStatus = new Uint8Array(4);
        this.parasiteToHostData = [
            new Uint8Array(TUBE_ULA_R1_PARASITE_BYTE_COUNT),
            new Uint8Array(1),
            new Uint8Array(2),
            new Uint8Array(1),
        ];
        this.hostToParasiteData = [new Uint8Array(1), new Uint8Array(1), new Uint8Array(2), new Uint8Array(1)];
        this.parasiteToHostFifoByteCount1 = 0;
        this.parasiteToHostFifoByteCount3 = 0;
        this.hostToParasiteFifoByteCount3 = 0;
        this.parasiteNmi = false;
        this.debug = false;
    }
    reset(updateInternalStatusRegister = true) {
        if (updateInternalStatusRegister) {
            this.internalStatusRegister = 0;
        }
        for (let i = 0; i < 4; i++) {
            //  register 1's spare bits carry the control flags instead, merged in when either side reads it
            const unused = i === TUBE_ULA_R1 ? 0 : TUBE_ULA_STATUS_UNUSED_BITS;
            this.hostStatus[i] = TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL | unused;
            this.parasiteStatus[i] = TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL | unused;
            if (i === TUBE_ULA_R3) {
                //  register 3 has one valid but insignificant byte in the parasite to host FIFO (this is to prevent an immediate PNMI state after PRST)
                this.hostStatus[i] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                this.parasiteToHostData[i][0] = 0;
            }
        }
        this.parasiteToHostFifoByteCount1 = 0;
        //  see info in the loop above from Tube Application Note about R3
        this.parasiteToHostFifoByteCount3 = 1;
        this.hostToParasiteFifoByteCount3 = 0;
        this.parasiteNmi = false;
        this.updateInterrupts();
    }

    /**
     * The register 3 condition the ULA raises an NMI from, before the M flag gates it: the host has
     * queued a whole transfer for the parasite, or the parasite has nothing queued back to the host.
     *
     * @returns {boolean} whether the condition currently holds
     */
    r3NmiCondition() {
        const bytesPerTransfer = this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_2_BYTE_R3_DATA ? 2 : 1;
        return this.hostToParasiteFifoByteCount3 >= bytesPerTransfer || this.parasiteToHostFifoByteCount3 === 0;
    }

    /** @returns {boolean} whether that condition is currently allowed to reach the parasite's NMI pin. */
    parasiteNmiEnabled() {
        return !!(this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_PARASITE_NMI_FROM_R3_DATA);
    }

    /** Drops the NMI request once the parasite has vectored through it. */
    acknowledgeNmi() {
        this.parasiteNmi = false;
        this.updateInterrupts();
    }

    /**
     * Withdraws a pending NMI whose register 3 condition has since gone away. Only the parasite's own
     * accesses can do this: a transfer it has satisfied no longer needs servicing.
     */
    clearNmiIfSatisfied() {
        if (!this.r3NmiCondition()) this.parasiteNmi = false;
    }
    updateInterrupts() {
        //  host IRQ
        if (
            this.hostStatus[TUBE_ULA_R4] & TUBE_ULA_FLAG_DATA_AVAILABLE &&
            this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_HOST_IRQ_FROM_R4_DATA
        ) {
            this.hostCpu.interrupt |= HOST_CPU_FLAG_IRQ_TUBE_ULA;
        } else {
            this.hostCpu.interrupt &= ~HOST_CPU_FLAG_IRQ_TUBE_ULA;
        }
        //  parasite IRQ
        if (
            (this.parasiteStatus[TUBE_ULA_R1] & TUBE_ULA_FLAG_DATA_AVAILABLE &&
                this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_PARASITE_IRQ_FROM_R1_DATA) ||
            (this.parasiteStatus[TUBE_ULA_R4] & TUBE_ULA_FLAG_DATA_AVAILABLE &&
                this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_PARASITE_IRQ_FROM_R4_DATA)
        ) {
            this.parasiteCpu.interrupt = true;
        } else {
            this.parasiteCpu.interrupt = false;
        }
        //  parasite NMI
        //  The ULA latches its NMI request rather than presenting the register 3 condition as a level:
        //  each host access to register 3 that gives the parasite something to do raises a request, and
        //  only the parasite can retire one, by servicing the transfer or by taking the NMI. Recomputing
        //  the condition here instead would lose every request raised while an earlier one still stood.
        this.parasiteCpu.NMI(this.parasiteNmi && this.parasiteNmiEnabled());
        //  parasite CPU RESET held low - not implemented in the CPU - the CPU should be frozen until this signal is released
        this.parasiteCpu.resetHeldLow = this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_PARASITE_RESET_ACTIVE_LOW;
    }
    hostRead(address) {
        let result = 0xfe;
        switch (address & 7) {
            case TUBE_ULA_R1_STATUS_ADDRESS:
                result =
                    (this.hostStatus[TUBE_ULA_R1] &
                        (TUBE_ULA_FLAG_DATA_AVAILABLE | TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL)) |
                    (this.internalStatusRegister & TUBE_ULA_CONTROL_FLAG_MASK);
                break;
            case TUBE_ULA_R1_DATA_ADDRESS:
                result = this.parasiteToHostData[TUBE_ULA_R1][0];
                if (this.hostStatus[TUBE_ULA_R1] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    for (let i = 1; i < TUBE_ULA_R1_PARASITE_BYTE_COUNT; i++) {
                        this.parasiteToHostData[TUBE_ULA_R1][i - 1] = this.parasiteToHostData[TUBE_ULA_R1][i];
                    }
                    this.parasiteStatus[TUBE_ULA_R1] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    this.parasiteToHostFifoByteCount1--;
                    if (this.parasiteToHostFifoByteCount1 === 0) {
                        this.hostStatus[TUBE_ULA_R1] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                    }
                }
                break;
            case TUBE_ULA_R2_STATUS_ADDRESS:
                result = this.hostStatus[TUBE_ULA_R2];
                break;
            case TUBE_ULA_R2_DATA_ADDRESS:
                result = this.parasiteToHostData[TUBE_ULA_R2][0];
                if (this.hostStatus[TUBE_ULA_R2] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    this.parasiteStatus[TUBE_ULA_R2] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    this.hostStatus[TUBE_ULA_R2] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                }
                break;
            case TUBE_ULA_R3_STATUS_ADDRESS:
                result = this.hostStatus[TUBE_ULA_R3];
                break;
            case TUBE_ULA_R3_DATA_ADDRESS:
                result = this.parasiteToHostData[TUBE_ULA_R3][0];
                if (this.hostStatus[TUBE_ULA_R3] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    this.parasiteToHostData[TUBE_ULA_R3][0] = this.parasiteToHostData[TUBE_ULA_R3][1];
                    this.parasiteStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    this.parasiteToHostFifoByteCount3--;
                    if (this.parasiteToHostFifoByteCount3 === 0) {
                        this.hostStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                        //  the parasite owes the host a byte, so ask it for one
                        this.parasiteNmi = true;
                    }
                }
                break;
            case TUBE_ULA_R4_STATUS_ADDRESS:
                result = this.hostStatus[TUBE_ULA_R4];
                break;
            case TUBE_ULA_R4_DATA_ADDRESS:
                result = this.parasiteToHostData[TUBE_ULA_R4][0];
                if (this.hostStatus[TUBE_ULA_R4] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    this.parasiteStatus[TUBE_ULA_R4] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    this.hostStatus[TUBE_ULA_R4] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                }
                break;
        }
        this.updateInterrupts();
        if (this.debug) {
            console.log("TUBE ULA: host read " + hexword(address) + " = " + hexbyte(result));
        }
        return result;
    }
    hostWrite(address, value) {
        if (this.debug) {
            console.log("TUBE ULA: host write " + hexword(address) + " = " + hexbyte(value));
        }
        switch (address & 7) {
            case TUBE_ULA_R1_STATUS_ADDRESS: {
                //  M and V both feed the NMI, so a write here can raise or drop the request on its own
                const nmiBefore = this.parasiteNmiEnabled() && this.r3NmiCondition();
                if (value & TUBE_ULA_FLAG_STATUS_SET_CONTROL_FLAGS) {
                    this.internalStatusRegister |= value & TUBE_ULA_CONTROL_FLAG_MASK;
                } else {
                    this.internalStatusRegister &= ~(value & TUBE_ULA_CONTROL_FLAG_MASK);
                }
                if (value & TUBE_ULA_FLAG_STATUS_CLEAR_ALL_TUBE_REGISTERS) {
                    this.reset(false);
                }
                if (value & TUBE_ULA_FLAG_STATUS_PARASITE_RESET_ACTIVE_LOW) {
                    //  there is still an issue with the parasite OS that runs after this happens
                    //  it prints the startup banner but then seems to stop responding when a R3 data
                    //  transfer (based on Advanced User Guide example) is attempted
                    if (this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_PARASITE_RESET_ACTIVE_LOW) {
                        this.parasiteCpu.reset(true); //  this in turn calls our this.reset(true)
                    }
                }
                const nmiAfter = this.parasiteNmiEnabled() && this.r3NmiCondition();
                if (!nmiBefore && nmiAfter) this.parasiteNmi = true;
                if (!nmiAfter) this.parasiteNmi = false;
                break;
            }
            case TUBE_ULA_R1_DATA_ADDRESS:
                if (this.hostStatus[TUBE_ULA_R1] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    this.hostToParasiteData[TUBE_ULA_R1][0] = value;
                    this.parasiteStatus[TUBE_ULA_R1] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                    this.hostStatus[TUBE_ULA_R1] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                }
                break;
            case TUBE_ULA_R2_DATA_ADDRESS:
                if (this.hostStatus[TUBE_ULA_R2] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    this.hostToParasiteData[TUBE_ULA_R2][0] = value;
                    this.parasiteStatus[TUBE_ULA_R2] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                    this.hostStatus[TUBE_ULA_R2] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                }
                break;
            case TUBE_ULA_R3_DATA_ADDRESS:
                if (this.hostStatus[TUBE_ULA_R3] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    if (this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_2_BYTE_R3_DATA) {
                        if (this.hostToParasiteFifoByteCount3 < 2) {
                            this.hostToParasiteData[TUBE_ULA_R3][this.hostToParasiteFifoByteCount3++] = value;
                        }
                        if (this.hostToParasiteFifoByteCount3 === 2) {
                            this.parasiteStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                            this.hostStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                            //  a whole transfer is waiting, so ask the parasite to take it
                            this.parasiteNmi = true;
                        }
                    } else {
                        this.hostToParasiteData[TUBE_ULA_R3][0] = value;
                        this.hostToParasiteFifoByteCount3 = 1;
                        this.parasiteStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                        this.hostStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                        this.parasiteNmi = true;
                    }
                }
                break;
            case TUBE_ULA_R4_DATA_ADDRESS:
                if (this.hostStatus[TUBE_ULA_R4] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    this.hostToParasiteData[TUBE_ULA_R4][0] = value;
                    this.parasiteStatus[TUBE_ULA_R4] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                    this.hostStatus[TUBE_ULA_R4] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                }
                break;
        }
        this.updateInterrupts();
    }
    parasiteRead(address) {
        //  Not implemented - needs to be integrated with the parasite CPU code:
        //  Boot mode is terminated by the software when it selects any one of the Tube addresses.
        //  This deselects the ROM
        let result = 0;
        switch (address & 7) {
            case TUBE_ULA_R1_STATUS_ADDRESS:
                result = this.parasiteStatus[TUBE_ULA_R1] | (this.internalStatusRegister & TUBE_ULA_CONTROL_FLAG_MASK);
                break;
            case TUBE_ULA_R1_DATA_ADDRESS:
                result = this.hostToParasiteData[TUBE_ULA_R1][0];
                if (this.parasiteStatus[TUBE_ULA_R1] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    this.hostStatus[TUBE_ULA_R1] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    this.parasiteStatus[TUBE_ULA_R1] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                }
                break;
            case TUBE_ULA_R2_STATUS_ADDRESS:
                result = this.parasiteStatus[TUBE_ULA_R2];
                break;
            case TUBE_ULA_R2_DATA_ADDRESS:
                result = this.hostToParasiteData[TUBE_ULA_R2][0];
                if (this.parasiteStatus[TUBE_ULA_R2] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    this.hostStatus[TUBE_ULA_R2] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    this.parasiteStatus[TUBE_ULA_R2] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                }
                break;
            case TUBE_ULA_R3_STATUS_ADDRESS:
                result = this.parasiteStatus[TUBE_ULA_R3];
                break;
            case TUBE_ULA_R3_DATA_ADDRESS:
                result = this.hostToParasiteData[TUBE_ULA_R3][0];
                if (this.parasiteStatus[TUBE_ULA_R3] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    this.hostToParasiteData[TUBE_ULA_R3][0] = this.hostToParasiteData[TUBE_ULA_R3][1];
                    this.hostToParasiteFifoByteCount3--;
                    if (this.hostToParasiteFifoByteCount3 === 0) {
                        this.hostStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                        this.parasiteStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                    }
                    this.clearNmiIfSatisfied();
                }
                break;
            case TUBE_ULA_R4_STATUS_ADDRESS:
                result = this.parasiteStatus[TUBE_ULA_R4];
                break;
            case TUBE_ULA_R4_DATA_ADDRESS:
                result = this.hostToParasiteData[TUBE_ULA_R4][0];
                if (this.parasiteStatus[TUBE_ULA_R4] & TUBE_ULA_FLAG_DATA_AVAILABLE) {
                    this.hostStatus[TUBE_ULA_R4] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    this.parasiteStatus[TUBE_ULA_R4] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                }
                break;
        }
        this.updateInterrupts();
        if (this.debug) {
            console.log("TUBE ULA: parasite read " + hexword(address) + " = " + hexbyte(result));
        }
        return result;
    }
    snapshotState() {
        return {
            internalStatusRegister: this.internalStatusRegister,
            hostStatus: this.hostStatus.slice(),
            parasiteStatus: this.parasiteStatus.slice(),
            parasiteToHostData: this.parasiteToHostData.map((fifo) => fifo.slice()),
            hostToParasiteData: this.hostToParasiteData.map((fifo) => fifo.slice()),
            parasiteToHostFifoByteCount1: this.parasiteToHostFifoByteCount1,
            parasiteToHostFifoByteCount3: this.parasiteToHostFifoByteCount3,
            hostToParasiteFifoByteCount3: this.hostToParasiteFifoByteCount3,
            parasiteNmi: this.parasiteNmi,
        };
    }

    /**
     * The interrupt and reset lines are not saved: they are derived from the status registers
     * and FIFO counts, in the same way the host's `interrupt` is rebuilt by the VIA and ACIA
     * restores. The latched NMI request is saved, as nothing else records whether the parasite
     * still owes the host a transfer.
     */
    restoreState(state) {
        this.internalStatusRegister = state.internalStatusRegister;
        this.hostStatus.set(state.hostStatus);
        this.parasiteStatus.set(state.parasiteStatus);
        for (let i = 0; i < 4; i++) {
            this.parasiteToHostData[i].set(state.parasiteToHostData[i]);
            this.hostToParasiteData[i].set(state.hostToParasiteData[i]);
        }
        this.parasiteToHostFifoByteCount1 = state.parasiteToHostFifoByteCount1;
        this.parasiteToHostFifoByteCount3 = state.parasiteToHostFifoByteCount3;
        this.hostToParasiteFifoByteCount3 = state.hostToParasiteFifoByteCount3;
        //  snapshots taken before the ULA latched its NMI have to fall back on the condition itself
        this.parasiteNmi = state.parasiteNmi ?? this.r3NmiCondition();
        this.updateInterrupts();
    }

    parasiteWrite(address, value) {
        //  Not implemented - needs to be integrated with the parasite CPU code:
        //  Boot mode is terminated by the software when it selects any one of the Tube addresses.
        //  This deselects the ROM
        if (this.debug) {
            console.log("TUBE ULA: parasite write " + hexword(address) + " = " + hexbyte(value));
        }
        switch (address & 7) {
            case TUBE_ULA_R1_DATA_ADDRESS:
                if (this.parasiteStatus[TUBE_ULA_R1] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    this.parasiteToHostData[TUBE_ULA_R1][this.parasiteToHostFifoByteCount1++] = value;
                    this.hostStatus[TUBE_ULA_R1] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                    if (this.parasiteToHostFifoByteCount1 === TUBE_ULA_R1_PARASITE_BYTE_COUNT) {
                        this.parasiteStatus[TUBE_ULA_R1] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    }
                }
                break;
            case TUBE_ULA_R2_DATA_ADDRESS:
                if (this.parasiteStatus[TUBE_ULA_R2] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    this.parasiteToHostData[TUBE_ULA_R2][0] = value;
                    this.hostStatus[TUBE_ULA_R2] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                    this.parasiteStatus[TUBE_ULA_R2] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                }
                break;
            case TUBE_ULA_R3_DATA_ADDRESS:
                if (this.parasiteStatus[TUBE_ULA_R3] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    if (this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_2_BYTE_R3_DATA) {
                        if (this.parasiteToHostFifoByteCount3 < 2) {
                            this.parasiteToHostData[TUBE_ULA_R3][this.parasiteToHostFifoByteCount3++] = value;
                        }
                        if (this.parasiteToHostFifoByteCount3 === 2) {
                            this.hostStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                            this.parasiteStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                        }
                    } else {
                        this.parasiteToHostData[TUBE_ULA_R3][0] = value;
                        this.parasiteToHostFifoByteCount3 = 1;
                        this.hostStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                        this.parasiteStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                    }
                    this.clearNmiIfSatisfied();
                }
                break;
            case TUBE_ULA_R4_DATA_ADDRESS:
                if (this.parasiteStatus[TUBE_ULA_R4] & TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL) {
                    this.parasiteToHostData[TUBE_ULA_R4][0] = value;
                    this.hostStatus[TUBE_ULA_R4] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                    this.parasiteStatus[TUBE_ULA_R4] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                }
                break;
        }
        this.updateInterrupts();
    }
}

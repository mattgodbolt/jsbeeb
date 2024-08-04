"use strict";
import * as utils from "./utils.js";

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
        this.debug = false;
    }
    reset(updateInternalStatusRegister = true) {
        if (updateInternalStatusRegister) {
            this.internalStatusRegister = 0;
        }
        for (let i = 0; i < 4; i++) {
            this.hostStatus[i] = TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
            this.parasiteStatus[i] = TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
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
        this.updateInterrupts();
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
        //  (from Tube Application Note)
        //  either: M = 1, V = 0, 1 or 2 bytes in host to parasite register 3 FIFO or 0 bytes in parasite
        //  to host register 3 FIFO (this allows single byte transfers across
        //  register 3)
        //  or: M = 1, V = 1, 2 bytes in host to parasite register 3 FIFO or 0 bytes in parasite to host
        //  register 3 FIFO. (this allows two byte transfers across register 3)
        const r3Size = this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_2_BYTE_R3_DATA ? 2 : 1;
        if (
            this.internalStatusRegister & TUBE_ULA_FLAG_STATUS_ENABLE_PARASITE_NMI_FROM_R3_DATA &&
            (this.hostToParasiteFifoByteCount3 >= r3Size || this.parasiteToHostFifoByteCount3 === 0)
        ) {
            this.parasiteCpu.NMI(true);
        } else {
            this.parasiteCpu.NMI(false);
        }
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
                    (this.internalStatusRegister &
                        ~(TUBE_ULA_FLAG_DATA_AVAILABLE | TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL));
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
                this.parasiteStatus[TUBE_ULA_R2] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                this.hostStatus[TUBE_ULA_R2] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
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
                    }
                }
                break;
            case TUBE_ULA_R4_STATUS_ADDRESS:
                result = this.hostStatus[TUBE_ULA_R4];
                break;
            case TUBE_ULA_R4_DATA_ADDRESS:
                result = this.parasiteToHostData[TUBE_ULA_R4][0];
                this.parasiteStatus[TUBE_ULA_R4] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                this.hostStatus[TUBE_ULA_R4] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                break;
        }
        this.updateInterrupts();
        if (this.debug) {
            console.log("TUBE ULA: host read " + utils.hexword(address) + " = " + utils.hexbyte(result));
        }
        return result;
    }
    hostWrite(address, value) {
        if (this.debug) {
            console.log("TUBE ULA: host write " + utils.hexword(address) + " = " + utils.hexbyte(value));
        }
        switch (address & 7) {
            case TUBE_ULA_R1_STATUS_ADDRESS:
                if (value & TUBE_ULA_FLAG_STATUS_SET_CONTROL_FLAGS) {
                    this.internalStatusRegister |=
                        value & ~(TUBE_ULA_FLAG_DATA_AVAILABLE | TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL);
                } else {
                    this.internalStatusRegister &= ~(
                        value & ~(TUBE_ULA_FLAG_DATA_AVAILABLE | TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL)
                    );
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
                break;
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
                            this.hostToParasiteData[this.hostToParasiteFifoByteCount3++] = value;
                        }
                        if (this.hostToParasiteFifoByteCount3 === 2) {
                            this.parasiteStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                            this.hostStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                        }
                    } else {
                        this.hostToParasiteData[TUBE_ULA_R3][0] = value;
                        this.hostToParasiteFifoByteCount3 = 1;
                        this.parasiteStatus[TUBE_ULA_R3] |= TUBE_ULA_FLAG_DATA_AVAILABLE;
                        this.hostStatus[TUBE_ULA_R3] &= ~TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
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
                result = this.parasiteStatus[TUBE_ULA_R1];
                break;
            case TUBE_ULA_R1_DATA_ADDRESS:
                result = this.hostToParasiteData[TUBE_ULA_R1][0];
                this.hostStatus[TUBE_ULA_R1] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                this.parasiteStatus[TUBE_ULA_R1] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                break;
            case TUBE_ULA_R2_STATUS_ADDRESS:
                result = this.parasiteStatus[TUBE_ULA_R2];
                break;
            case TUBE_ULA_R2_DATA_ADDRESS:
                result = this.hostToParasiteData[TUBE_ULA_R2][0];
                this.hostStatus[TUBE_ULA_R2] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                this.parasiteStatus[TUBE_ULA_R2] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
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
                }
                break;
            case TUBE_ULA_R4_STATUS_ADDRESS:
                result = this.parasiteStatus[TUBE_ULA_R4];
                break;
            case TUBE_ULA_R4_DATA_ADDRESS:
                result = this.hostToParasiteData[TUBE_ULA_R4][0];
                this.hostStatus[TUBE_ULA_R4] |= TUBE_ULA_FLAG_DATA_REGISTER_NOT_FULL;
                this.parasiteStatus[TUBE_ULA_R4] &= ~TUBE_ULA_FLAG_DATA_AVAILABLE;
                break;
        }
        this.updateInterrupts();
        if (this.debug) {
            console.log("TUBE ULA: parasite read " + utils.hexword(address) + " = " + utils.hexbyte(result));
        }
        return result;
    }
    parasiteWrite(address, value) {
        //  Not implemented - needs to be integrated with the parasite CPU code:
        //  Boot mode is terminated by the software when it selects any one of the Tube addresses.
        //  This deselects the ROM
        if (this.debug) {
            console.log("TUBE ULA: parasite write " + utils.hexword(address) + " = " + utils.hexbyte(value));
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

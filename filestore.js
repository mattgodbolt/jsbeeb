// Level-3 file server emulator ported from FSEM2
// https://github.com/mmbeeb/FSEM

"use strict";

import { ReceiveBlock, EconetPacket } from "./econet.js";
import * as utils from "./utils.js";

export class Filestore {
    constructor(cpu, econet) {
        this.cpu = cpu;
        this.econet = econet;
        this.scsi = [];
        this.l3fs = [];
        this.pollCount = 0;
        this.ram = new Uint8Array((64 + 32) * 1024);
        this.emulationSpeed = 0;
        this.logTemp = "";

        this.A = this.X = this.Y = this.SP = this.M = 0;
        this.PC = this.XPC = this.L = this.R = 0;
        this.N = this.V = this.Z = this.C = this.F = 0;
    }

    GBYTE() {
        return this.ram[this.PC++];
    }
    GWORD() {
        return this.ram[this.PC++] | (this.ram[this.PC++] << 8);
    }
    WORD(l) {
        return this.ram[l] | (this.ram[l + 1] << 8);
    }
    PUSH(m) {
        this.ram[0x100 + this.SP] = m;
        this.SP--;
        this.SP &= 0xff;
    }

    PULL() {
        this.SP++;
        this.SP &= 0xff;
        return this.ram[0x100 + this.SP];
    }

    NZ(v) {
        v &= 0xff;
        this.Z = 0 | (v === 0x00);
        this.N = 0 | (v >= 0x80);
        return v;
    }

    oswrch(char) {
        if (this.emulationSpeed === 0) {
            // During startup, run the FS emulation at full speed and log output
            if (char >= 32 && char <= 127) {
                this.logTemp += String.fromCharCode(char);
            }

            if (char === 13) {
                console.log("Filestore: " + this.logTemp.trim());
                if (this.logTemp.includes("Starting")) {
                    this.emulationSpeed = 20; // Once started up, we can slow down the emulation considerably
                }
                this.logTemp = "";
            }
        }
    }

    osword() {
        let p = (this.Y << 8) | this.X;
        switch (this.A) {
            case 0x0: {
                // Read line (put '1' into buffer, Drives/stations = 1)
                let k = this.ram[p] | (this.ram[p + 1] << 8);
                this.ram[k] = 49; // '1'
                this.ram[k + 1] = 13;
                this.Y = 1;
                this.C = 0;

                this.oswrch(49); // '1'
                break;
            }

            case 0x0e: {
                const current = new Date();
                this.ram[p] = current.getFullYear() - 2000;
                this.ram[p + 1] = current.getMonth() + 1;
                this.ram[p + 2] = current.getDate();
                this.ram[p + 3] = current.getDay() + 1;
                this.ram[p + 4] = current.getHours();
                this.ram[p + 5] = current.getMinutes();
                this.ram[p + 6] = current.getSeconds();
                break;
            }

            case 0x10: {
                // Transmit
                let stationId = this.ram[p + 2];

                if (stationId !== 0xff) {
                    let bufstart =
                        (this.ram[p + 4] |
                            (this.ram[p + 5] << 8) |
                            (this.ram[p + 6] << 16) |
                            (this.ram[p + 7] << 24)) >>>
                        0;
                    let bufend =
                        (this.ram[p + 8] |
                            (this.ram[p + 9] << 8) |
                            (this.ram[p + 10] << 16) |
                            (this.ram[p + 11] << 24)) >>>
                        0;
                    let length = bufend - bufstart;

                    if (bufstart >= 0x10000) bufstart = (bufstart & 0xffff) | 0x10000;

                    this.econet.serverTx = new EconetPacket(stationId, 0, 254, 0);
                    this.econet.serverTx.controlFlag = this.ram[p];
                    this.econet.serverTx.port = this.ram[p + 1];

                    for (let i = 0; i < length; i++) {
                        this.econet.serverTx.buffer[i + 4] = this.ram[bufstart + i];
                    }
                    this.econet.serverTx.bytesInBuffer = 4 + length;
                }
                break;
            }

            case 0x11: {
                // Receive
                if (this.ram[p + 0] === 0) {
                    // Create new receive block
                    let rxBuffer = new ReceiveBlock(
                        this.econet.nextReceiveBlockNumber,
                        this.ram[p + 1],
                        this.ram[p + 2],
                        (this.ram[p + 5] |
                            (this.ram[p + 6] << 8) |
                            (this.ram[p + 7] << 16) |
                            (this.ram[p + 8] << 24)) >>>
                            0,
                        (this.ram[p + 9] |
                            (this.ram[p + 10] << 8) |
                            (this.ram[p + 11] << 16) |
                            (this.ram[p + 12] << 24)) >>>
                            0,
                    );

                    this.econet.receiveBlocks.push(rxBuffer);
                    this.ram[p] = this.econet.nextReceiveBlockNumber;
                    this.econet.nextReceiveBlockNumber++;
                    this.econet.nextReceiveBlockNumber &= 0xff;
                    if (this.econet.nextReceiveBlockNumber === 0) {
                        this.econet.nextReceiveBlockNumber = 1;
                    }

                    //console.log("Filestore: new receive block " + rxBuffer.id + " " + rxBuffer.receivePort.toString(16) + " " + rxBuffer.bufferStart.toString(16) + " " + rxBuffer.bufferEnd.toString(16));
                } // Read and delete receive block
                else {
                    let rxblock = this.econet.receiveBlocks.find((e) => e.id === this.ram[p + 0]);
                    if (rxblock.bufferStart + rxblock.data.bytesInBuffer - 4 < rxblock.bufferEnd) {
                        rxblock.bufferEnd = rxblock.bufferStart + rxblock.data.bytesInBuffer - 4;
                    }
                    this.ram[p + 1] = rxblock.controlFlag;
                    this.ram[p + 2] = rxblock.receivePort;
                    this.ram[p + 3] = rxblock.stationId;
                    this.ram[p + 4] = 0;
                    this.ram[p + 5] = rxblock.bufferStart & 0xff;
                    this.ram[p + 6] = (rxblock.bufferStart >>> 8) & 0xff;
                    this.ram[p + 7] = (rxblock.bufferStart >>> 16) & 0xff;
                    this.ram[p + 8] = (rxblock.bufferStart >>> 24) & 0xff;
                    this.ram[p + 9] = rxblock.bufferEnd & 0xff;
                    this.ram[p + 10] = (rxblock.bufferEnd >>> 8) & 0xff;
                    this.ram[p + 11] = (rxblock.bufferEnd >>> 16) & 0xff;
                    this.ram[p + 12] = (rxblock.bufferEnd >>> 24) & 0xff;

                    // Copy buffer contents to FS memory
                    let bufferStart = rxblock.bufferStart;
                    if (bufferStart >= 0x10000) bufferStart = (bufferStart & 0xffff) | 0x10000;

                    for (let i = 0; i < rxblock.bufferEnd - rxblock.bufferStart; i++) {
                        this.ram[bufferStart + i] = rxblock.data.buffer[i + 4];
                    }

                    this.econet.deleteReceiveBlock(this.ram[p]);
                    //console.log("Filestore: read and delete receive block " + this.ram[p]);
                }
                break;
            }

            case 0x13:
                this.ram[p + 1] = 254; // Station ID
                break;

            case 0x72: {
                // SCSI handling
                let addr =
                    (this.ram[p + 1] | (this.ram[p + 2] << 8) | (this.ram[p + 3] << 16) | (this.ram[p + 4] << 24)) >>>
                    0;
                if (addr >= 0x10000) addr = (addr & 0xffff) | 0x10000; //host memory

                let result = 4,
                    sec = ((this.ram[p + 6] & 0x1f) << 16) | (this.ram[p + 7] << 8) | this.ram[p + 8];
                let len = this.ram[p + 9] * 0x100; // SCSI_SECSIZE

                if (!len)
                    len =
                        this.ram[p + 11] |
                        ((this.ram[p + 12] << 8) | (this.ram[p + 13] << 16) | ((this.ram[p + 14] << 24) >>> 0));

                switch (this.ram[p + 5]) {
                    case 0x08: //read
                    case 0x0a: //write
                        if (this.ram[p + 5] === 0x08) {
                            // read
                            for (let i = sec * 0x100; i < sec * 0x100 + len; i++) {
                                this.ram[addr++] = this.scsi[i];
                            }
                        } // write
                        else
                            for (let i = sec * 0x100; i < sec * 0x100 + len; i++) {
                                this.scsi[i] = this.ram[addr++];
                            }

                        result = 0;
                        break;

                    default:
                        break;
                }

                this.ram[p] = result;
                break;
            }

            case 0x73:
                this.ram[p] = 0; //sector
                this.ram[p + 1] = 0;
                this.ram[p + 2] = 0;
                this.ram[p + 3] = 0;
                this.ram[p + 4] = 0;
                break;

            default:
                console.log("Filestore: unhandled osword 0x" + this.A.toString(16));
                break;
        }
    }

    osbyte() {
        switch (this.A) {
            case 0x0d:
            case 0x0e:
            case 0x0f:
                break;

            case 0x32: // Poll transmit block
                if (this.econet.serverTx.bytesInBuffer > 0) {
                    this.X = 0x80;
                } else {
                    this.X = 0;
                }
                break;

            case 0x33: {
                // Poll receive block
                let rxblock = this.econet.receiveBlocks.find((e) => e.id === this.X);
                this.X = 0;
                if (rxblock) {
                    this.X = rxblock.controlFlag;

                    if (this.X >= 0x80) {
                        this.X = rxblock.controlFlag;
                        //console.log("osbyte found received block id " + rxblock.id + " " + this.X.toString(16) + " " + this.Y.toString(16));
                    }
                }
                break;
            }

            case 0x34:
                this.econet.deleteReceiveBlock(this.X);
                break;
            case 0x35:
                break;
            case 0x85:
                this.X = 0;
                this.Y = 32 << 2;
                break;
            case 0x86:
                this.X = this.Y = 0;
                break;
            case 0x87:
            case 0x96:
            case 0x97:
                break;
            case 0xb4:
                this.X = 0;
                break;
            case 0xe5:
                break;

            default:
                console.log("Filestore: unhandled osbyte 0x" + this.A.toString(16));
                break;
        }
    }

    reset() {
        console.log("Filestore: initialisation");

        const filestoreRef = this;
        utils.loadData("econet/L3FS.dat").then(function (data) {
            filestoreRef.l3fs = data;
            for (let i = 0; i < data.length; i++) {
                filestoreRef.ram[0x400 + i] = data[i];
            }
            filestoreRef.PC = 0x400;
            filestoreRef.SP = 0xff;
            filestoreRef.A = 1;
        });
        utils.loadData("econet/scsi.dat").then(function (data) {
            filestoreRef.scsi = data;
        });
    }

    polltime(cycles) {
        this.pollCount += cycles;
        if (this.pollCount > this.emulationSpeed) {
            this.pollCount = 0;

            // Decode and execute next instruction
            let op,
                i,
                i2,
                j = 0;

            this.XPC = this.PC;
            if (this.PC >= 0xf800)
                op = 0x60; //ROM, read rts
            else op = this.GBYTE();

            i = op & 0x1f; //row
            i2 = i & 0x03;
            j = op >> 5; //column

            if (i === 0 && j < 4) {
                //all implicit except JSR
                switch (j) {
                    case 0: //brk
                        this.PC = this.WORD(0x0202); //BRKV
                        break;
                    case 1: //jsr, absolute
                        this.L = this.GWORD();
                        this.PUSH(--this.PC >> 8);
                        this.PUSH(this.PC);
                        this.PC = this.L;
                        break;
                    case 2: //rti
                        break;
                    case 3: //rts
                        this.PC = this.PULL();
                        this.PC |= this.PULL() << 8;
                        this.PC++;
                        break;
                }
            } else if (i === 8) {
                //all implicit
                switch (j) {
                    case 0: //php
                        this.M = (this.N << 7) | (this.V << 6) | (this.Z << 1) | this.C;
                        this.PUSH(this.M);
                        break;
                    case 1: //plp
                        this.M = this.PULL();
                        this.N = (this.M & 0x80) > 0;
                        this.V = (this.M & 0x40) > 0;
                        this.Z = (this.M & 2) > 0;
                        this.C = this.M & 1;
                        break;
                    case 2: //pha
                        this.PUSH(this.A);
                        break;
                    case 3: //pla
                        this.A = this.NZ(this.PULL());
                        break;
                    case 4: //dey
                        this.Y--;
                        this.Y &= 0xff;
                        this.NZ(this.Y);
                        break;
                    case 5: //tay
                        this.Y = this.NZ(this.A);
                        break;
                    case 6: //iny
                        this.Y++;
                        this.Y &= 0xff;
                        this.NZ(this.Y);
                        break;
                    case 7: //inx
                        this.X++;
                        this.X &= 0xff;
                        this.NZ(this.X);
                        break;
                }
            } else if (i === 10 && j > 3) {
                //all implicit
                switch (j) {
                    case 4: //txa
                        this.A = this.NZ(this.X);
                        break;
                    case 5: //tax
                        this.X = this.NZ(this.A);
                        break;
                    case 6: //dex
                        this.X--;
                        this.X &= 0xff;
                        this.NZ(this.X);
                        break;
                    case 7: //nop
                        break;
                }
            } else if (i === 16) {
                //branch, all relative
                let flag = ~j & 1;
                switch (j >> 1) {
                    case 0:
                        flag ^= this.N;
                        break;
                    case 1:
                        flag ^= this.V;
                        break;
                    case 2:
                        flag ^= this.C;
                        break;
                    case 3:
                        flag ^= this.Z;
                        break;
                }

                this.M = this.GBYTE();

                if (flag) {
                    if (this.M & 0x80) this.PC -= 0x100;
                    this.PC += this.M;
                }
            } else if (i === 24) {
                //all implicit
                switch (j) {
                    case 0: //clc
                        this.C = 0;
                        break;
                    case 1: //sec
                        this.C = 1;
                        break;
                    case 2: //cli
                        break;
                    case 3: //sei
                        break;
                    case 4: //tya
                        this.A = this.NZ(this.Y);
                        break;
                    case 5: //clv
                        this.V = 0;
                        break;
                    case 6: //cld
                        break;
                    case 7: //sed
                        break;
                }
            } else if (i === 26) {
                //all implicit
                if (j & 1)
                    //tsx
                    this.X = this.NZ(this.SP);
                //txs
                else this.SP = this.X;
            } else {
                //multiple address modes
                let acc = 0,
                    imm = 0,
                    store = 0;

                if (i === 10) {
                    acc = 1;
                } else {
                    if (i === 1) {
                        //(zp,X)
                        this.L = this.GBYTE() + this.X;
                        this.L = this.WORD(this.L);
                    } else if (i === 25 || op === 190) {
                        //LDX abs,Y
                        this.L = this.GWORD() + this.Y;
                    } else {
                        switch (i >> 2) {
                            case 0: //#
                            case 2: //#
                                imm = 1;
                                break;
                            case 1: //zp
                                this.L = this.GBYTE();
                                break;
                            case 3: //abs
                                this.L = this.GWORD();
                                break;
                            case 4: //(zp),Y
                                this.L = this.GBYTE();
                                this.L = this.WORD(this.L) + this.Y;
                                break;
                            case 5:
                                if (op === 150)
                                    //STX zp,Y
                                    this.L = this.GBYTE() + this.Y;
                                //zp,X
                                else this.L = this.GBYTE() + this.X;
                                break;
                            case 7: //abs,X
                                this.L = this.GWORD() + this.X;
                                break;
                        }
                    }
                }

                if (acc) this.M = this.A;
                else if (imm) this.M = this.GBYTE();
                else this.M = this.ram[this.L];

                switch (i2) {
                    case 0:
                        switch (j) {
                            case 1: //bit
                                this.NZ(this.A & this.M);
                                this.V = (this.M & 0x40) > 0;
                                this.N = (this.M & 0x80) > 0;
                                break;
                            case 2: //jmp absolute
                                this.PC = this.L;
                                break;
                            case 3: //jmp indirect
                                this.PC = this.WORD(this.L);
                                break;
                            case 4: //sty
                                this.M = this.Y;
                                store = 1;
                                break;
                            case 5: //ldy
                                this.Y = this.NZ(this.M);
                                break;
                            case 6: //cpy
                                this.NZ(this.Y - this.M);
                                this.C = this.Y >= this.M;
                                break;
                            case 7: //cpx
                                this.NZ(this.X - this.M);
                                this.C = this.X >= this.M;
                                break;
                        }
                        break;
                    case 1:
                        switch (j) {
                            case 0: //ora
                                this.A = this.NZ(this.A | this.M);
                                break;
                            case 1: //and
                                this.A = this.NZ(this.A & this.M);
                                break;
                            case 2: //eor
                                this.A = this.NZ(this.A ^ this.M);
                                break;
                            case 7: //sbc
                                this.M = ~this.M & 0xff;
                            // falls through
                            case 3: //adc
                                this.R = this.A + this.M + this.C;
                                this.C = this.R >= 0x100;
                                this.V = ((this.A ^ this.R) & (this.M ^ this.R) & 0x80) > 0;
                                this.A = this.NZ(this.R);
                                break;
                            case 4: //sta
                                this.M = this.A;
                                store = 1;
                                break;
                            case 5: //lda
                                this.A = this.NZ(this.M);
                                break;
                            case 6: //cmp
                                this.NZ(this.A - this.M);
                                this.C = this.A >= this.M;
                                break;
                        }
                        break;
                    case 2:
                        store = 1;
                        switch (j) {
                            case 0: //asl
                                this.C = 0;
                            // falls through
                            case 1: //rol
                                this.F = (this.M & 0x80) > 0;
                                this.M = this.NZ((this.M << 1) | this.C);
                                this.C = this.F;
                                break;
                            case 2: //lsr
                                this.C = 0;
                            // falls through
                            case 3: //ror
                                this.F = this.M & 1;
                                this.M = this.NZ((this.M >> 1) | (this.C << 7));
                                this.C = this.F;
                                break;
                            case 4: //stx
                                this.M = this.X;
                                break;
                            case 5: //ldx
                                this.X = this.NZ(this.M);
                                store = 0;
                                break;
                            case 6: //dec
                                this.M--;
                                this.M &= 0xff;
                                this.NZ(this.M);
                                break;
                            case 7: //inc
                                this.M++;
                                this.M &= 0xff;
                                this.NZ(this.M);
                                break;
                        }
                        break;
                }

                if (store) {
                    if (acc) this.A = this.M;
                    else this.ram[this.L] = this.M;
                }
            }

            // Have we been asked to execute an OS ROM call?
            if (this.PC >= 0xf800) {
                switch (this.PC) {
                    case 0xf800: //reset
                        break;
                    case 0xffe0: //OSRDCH
                        this.A = 83; // The letter 'S' (tells FS3 to start)
                        this.C = 0;
                        break;
                    case 0xfff1: //OSWORD
                        this.osword();
                        break;
                    case 0xfff4: //OSBYTE
                        this.osbyte();
                        break;
                    case 0xffe7: //OSNEWL
                    case 0xffe3: //OSASCI
                    case 0xffee: //OSWRCH
                        this.oswrch(this.A);
                        break;
                    case 0xfff7: //OSCLI
                        break;
                    default:
                        break;
                }
            }
        }
    }
}

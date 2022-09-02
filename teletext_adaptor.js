"use strict";

import * as utils from "./utils.js";

// Code ported from Beebem (C to .js) by Jason Robson
const TELETEXT_IRQ = 5;
const TELETEXT_FRAME_SIZE = 860;
const TELETEXT_UPDATE_FREQ = 50000;

/*

Offset  Description                 Access  
+00     Status register             R/W
+01     Row register
+02     Data register
+03     Clear status register

Status register:
  Read
   Bits     Function
   0-3      Link settings
   4        FSYN (Latches high on Field sync)
   5        DEW (Data entry window)
   6        DOR (Latches INT on end of DEW)
   7        INT (latches high on end of DEW)
  
  Write
   Bits     Function
   0-1      Channel select
   2        Teletext Enable
   3        Enable Interrupts
   4        Enable AFC (and mystery links A)
   5        Mystery links B

*/

export class TeletextAdaptor {
    constructor(cpu) {
        this.cpu = cpu;
        this.teletextStatus = 0x0f; /* low nibble comes from LK4-7 and mystery links which are left floating */
        this.teletextInts = false;
        this.teletextEnable = false;
        this.channel = 0;
        this.currentFrame = 0;
        this.totalFrames = 0;
        this.rowPtr = 0x00;
        this.colPtr = 0x00;
        this.frameBuffer = new Array(16).fill(0).map(() => new Array(64).fill(0));
        this.streamData = null;
        this.pollCount = 0;
    }

    reset(hard) {
        if (hard) {
            console.log("Teletext adaptor: initialisation");
            this.loadChannelStream(this.channel);
        }
    }

    loadChannelStream(channel) {
        console.log("Teletext adaptor: switching to channel " + channel);
        const teletextRef = this;
        utils.loadData("teletext/txt" + channel + ".dat").then(function (data) {
            teletextRef.streamData = data;
            teletextRef.totalFrames = data.length / TELETEXT_FRAME_SIZE;
            teletextRef.currentFrame = 0;
        });
    }

    read(addr) {
        let data = 0x00;

        switch (addr) {
            case 0x00: // Status Register
                data = this.teletextStatus;
                break;
            case 0x01: // Row Register
                break;
            case 0x02: // Data Register
                data = this.frameBuffer[this.rowPtr][this.colPtr++];
                break;
            case 0x03:
                this.teletextStatus &= ~0xd0; // Clear INT, DOR, and FSYN latches
                this.cpu.interrupt &= ~(1 << TELETEXT_IRQ);
                break;
        }

        return data;
    }

    write(addr, value) {
        switch (addr) {
            case 0x00:
                // Status register
                this.teletextInts = (value & 0x08) === 0x08;
                if (this.teletextInts && this.teletextStatus & 0x80) {
                    this.cpu.interrupt |= 1 << TELETEXT_IRQ; // Interrupt if INT and interrupts enabled
                } else {
                    this.cpu.interrupt &= ~(1 << TELETEXT_IRQ); // Clear interrupt
                }
                this.teletextEnable = (value & 0x04) === 0x04;
                if ((value & 0x03) !== this.channel && this.teletextEnable) {
                    this.channel = value & 0x03;
                    this.loadChannelStream(this.channel);
                }
                break;

            case 0x01:
                this.rowPtr = value;
                this.colPtr = 0x00;
                break;

            case 0x02:
                this.frameBuffer[this.rowPtr][this.colPtr++] = value & 0xff;
                break;

            case 0x03:
                this.teletextStatus &= ~0xd0; // Clear INT, DOR, and FSYN latches
                this.cpu.interrupt &= ~(1 << TELETEXT_IRQ); // Clear interrupt
                break;
        }
    }

    // Attempt to emulate the TV broadcast
    polltime(cycles) {
        this.pollCount += cycles;
        if (this.pollCount > TELETEXT_UPDATE_FREQ) {
            this.pollCount = 0;
            // Don't flood the processor with teletext interrupts during a reset
            if (this.cpu.resetLine) {
                this.update();
            } else {
                // Grace period before we start up again
                this.pollCount = -TELETEXT_UPDATE_FREQ * 10;
            }
        }
    }

    update() {
        if (this.currentFrame >= this.totalFrames) {
            this.currentFrame = 0;
        }

        const offset = this.currentFrame * TELETEXT_FRAME_SIZE + 3 * 43;

        this.teletextStatus &= 0x0f;
        this.teletextStatus |= 0xd0; // data ready so latch INT, DOR, and FSYN

        if (this.teletextEnable) {
            // Copy current stream position into the frame buffer
            for (let i = 0; i < 16; ++i) {
                if (this.streamData[offset + i * 43] !== 0) {
                    this.frameBuffer[i][0] = 0x67;
                    for (let j = 1; j <= 42; j++) {
                        this.frameBuffer[i][j] = this.streamData[offset + (i * 43 + (j - 1))];
                    }
                } else {
                    this.frameBuffer[i][0] = 0x00;
                }
            }
        }

        this.currentFrame++;

        this.rowPtr = 0x00;
        this.colPtr = 0x00;

        if (this.teletextInts) {
            this.cpu.interrupt |= 1 << TELETEXT_IRQ;
        }
    }
}

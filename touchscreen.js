"use strict";

import * as utils from "./utils.js";

const PollHz = 8; // Made up
const PollCycles = (2 * 1000 * 1000) / PollHz;

function doScale(val, scale, margin) {
    val = (val - margin) / (1 - 2 * margin);
    return val * scale;
}

export class TouchScreen {
    constructor(scheduler) {
        this.scheduler = scheduler;
        this.mouse = [];
        this.outBuffer = new utils.Fifo(16);
        this.delay = 0;
        this.mode = 0;
        this.pollTask = this.scheduler.newTask(this.poll);
    }

    tryReceive(rts) {
        if (self.outBuffer.size && rts) return self.outBuffer.get();
        return -1;
    }

    doRead() {
        const scaleX = 120,
            marginX = 0.13;
        const scaleY = 100,
            marginY = 0.03;
        const scaledX = doScale(self.mouse.x, scaleX, marginX);
        const scaledY = doScale(1 - self.mouse.y, scaleY, marginY);
        const toSend = [0x4f, 0x4f, 0x4f, 0x4f];
        const x = Math.min(255, Math.max(0, scaledX)) | 0;
        const y = Math.min(255, Math.max(0, scaledY)) | 0;
        if (self.mouse.button) {
            toSend[0] = 0x40 | ((x & 0xf0) >>> 4);
            toSend[1] = 0x40 | (x & 0x0f);
            toSend[2] = 0x40 | ((y & 0xf0) >>> 4);
            toSend[3] = 0x40 | (y & 0x0f);
        }
        for (let i = 0; i < 4; ++i) self.store(toSend[i]);
        self.store(".".charCodeAt(0));
    }

    poll() {
        self.doRead();
        self.pollTask.reschedule(PollCycles);
    }

    store(byte) {
        self.outBuffer.put(byte);
    }

    onMouse(x, y, button) {
        this.mouse = { x: x, y: y, button: button };
    }

    onTransmit(val) {
        switch (String.fromCharCode(val)) {
            case "M":
                self.mode = 0;
                break;
            case "0":
            case "1":
            case "2":
            case "3":
            case "4":
            case "5":
            case "6":
            case "7":
            case "8":
            case "9":
                self.mode = 10 * self.mode + val - "0".charCodeAt(0);
                break;
            case ".":
                break;
            case "?":
                if (self.mode === 1) self.doRead();
                break;
        }
        self.pollTask.ensureScheduled(self.mode === 129 || self.mode === 130, PollCycles);
    }
}

"use strict";

const table = [19200, 9600, 4800, 2400, 1200, 300, 150, 75];

export class Serial {
    constructor(acia) {
        this.acia = acia;
        this.reset();
    }

    reset() {
        this.reg = 0;
        this.transmitRate = 0;
        this.receiveRate = 0;
    }

    write(addr, val) {
        val &= 0xff;
        this.reg = val;
        this.transmitRate = val & 0x07;
        this.receiveRate = (val >>> 3) & 0x07;
        this.acia.setSerialReceive(table[this.receiveRate]);
        this.acia.setMotor(!!(val & 0x80));
        this.acia.selectRs423(!!(val & 0x40));
    }

    read() {
        this.write(0, 0xfe);
        return 0;
    }

    /**
     * Save Serial state
     * @param {SaveState} saveState The SaveState to save to
     */
    saveState(saveState) {
        const state = {
            reg: this.reg,
            transmitRate: this.transmitRate,
            receiveRate: this.receiveRate,
        };

        saveState.addComponent("serial", state);
    }

    /**
     * Load Serial state
     * @param {SaveState} saveState The SaveState to load from
     */
    loadState(saveState) {
        const state = saveState.getComponent("serial");
        if (!state) return;

        // Directly set internal state first
        this.reg = state.reg;
        this.transmitRate = state.transmitRate;
        this.receiveRate = state.receiveRate;

        // Restore the actual hardware state through write
        // We don't call write() directly because it would overwrite our already loaded state
        this.acia.setSerialReceive(table[this.receiveRate]);
        this.acia.setMotor(!!(this.reg & 0x80));
        this.acia.selectRs423(!!(this.reg & 0x40));
    }
}

"use strict";

export class Adc {
    constructor(sysvia, scheduler) {
        this.sysvia = sysvia;
        this.task = scheduler.newTask(this.onComplete.bind(this));
        this.status = 0x40;
        this.low = 0x00;
        this.high = 0x00;
    }

    reset() {
        this.status = 0x40;
        this.low = 0x00;
        this.high = 0x00;
    }

    read(addr) {
        switch (addr & 3) {
            case 0:
                return this.status;
            case 1:
                return this.high;
            case 2:
                return this.low;
            default:
                break;
        }
        return 0x40;
    }

    write(addr, val) {
        if ((addr & 3) !== 0) return;
        // 8 bit conversion takes 4ms whereas 10 bit conversions take 10ms, according to AUG
        this.task.cancel();
        this.task.schedule(val & 0x08 ? 20000 : 8000);
        this.status = (val & 0x0f) | 0x80;
        this.sysvia.setcb1(true);
    }

    onComplete() {
        let val = 0x8000;

        const pads = this.sysvia.getGamepads();
        if (pads && pads[0]) {
            const pad = pads[0];
            const pad2 = pads[1];

            let rawValue = 0;

            const stick = Math.floor(this.status & 0x03);

            switch (stick) {
                default:
                case 0:
                    rawValue = pad.axes[0];
                    break;
                case 1:
                    rawValue = pad.axes[1];
                    break;
                case 2:
                    if (pad2) {
                        rawValue = pad2.axes[0];
                    } else {
                        rawValue = pad.axes[2];
                    }
                    break;
                case 3:
                    if (pad2) {
                        rawValue = pad2.axes[1];
                    } else {
                        rawValue = pad.axes[3];
                    }
                    break;
            }

            // scale from [1,-1] to [0,0xffff]
            val = Math.floor(((1 - rawValue) / 2) * 0xffff);
        }
        this.status = (this.status & 0x0f) | 0x40 | ((val >>> 10) & 0x03);
        this.low = val & 0xff;
        this.high = (val >>> 8) & 0xff;
        this.sysvia.setcb1(false);
    }

    /**
     * Save ADC state
     * @param {SaveState} saveState The SaveState to save to
     */
    saveState(saveState) {
        const state = {
            status: this.status,
            low: this.low,
            high: this.high,
            // Save the scheduled task time if it exists
            scheduledTime: this.task.when - this.task.scheduler.currentTime,
        };

        saveState.addComponent("adc", state);
    }

    /**
     * Load ADC state
     * @param {SaveState} saveState The SaveState to load from
     */
    loadState(saveState) {
        const state = saveState.getComponent("adc");
        if (!state) return;

        this.status = state.status;
        this.low = state.low;
        this.high = state.high;

        // Cancel any existing task
        this.task.cancel();

        // Reschedule the task if it was scheduled
        if (state.scheduledTime > 0) {
            this.task.schedule(state.scheduledTime);
        }
    }
}

// The AMX mouse, on the user port. Each axis is a quadrature pair: X1 on CB1 with X2 on PB0, and Y1 on CB2 with Y2
// on PB2. The buttons pull PB5 (left), PB6 (middle) and PB7 (right) low. As BeebEm, b-em and MAME have it, and as AMX
// Design's and J.G. Harston's drivers read it: a falling edge on X1 or Y1 finds X2 or Y2 high moving right or up.

export const AmxButtons = Object.freeze({ left: 1, middle: 2, right: 4 });

const X2 = 0x01;
const Y2 = 0x04;
const ButtonsShift = 5;
const ViaCb1Flag = 0x10;
const ViaCb2Flag = 0x08;
const PhaseMask = 3;
// In 2MHz ticks. BeebEm spends 250 on each count; a count here is four steps.
const StepTicks = 64;
// Software that leaves a flag set this long, 5ms, is not reading the mouse, which drops what it has still to do.
const StalledSteps = 156;

// Stepping right or up goes up through the phases: (X1, X2) = (0, 0), (1, 0), (1, 1), (0, 1).
const lineLevel = (phase) => phase === 1 || phase === 2;
const directionLevel = (phase) => phase >= 2;

export class AmxMouse {
    constructor(scheduler) {
        /** @type {import("./replay.js").InputLog | null} */
        this.inputLog = null;
        this.via = null;
        this.buttons = 0;
        this.held = false;
        this.x = { pending: 0, phase: 0 };
        this.y = { pending: 0, phase: 0 };
        this.setX1 = (level) => this.via.setcb1(level);
        this.setY1 = (level) => this.via.setcb2(level);
        this.stepTask = scheduler.newTask(() => this._step());
        this.reset();
    }

    /** @param {import("./via.js").UserVia} via the VIA whose port B and CB lines the mouse drives */
    connect(via) {
        this.via = via;
    }

    /** Drops any movement still to make. The phases are where the mouse's wheels stand, which a reset leaves be. */
    reset() {
        this.x.pending = 0;
        this.y.pending = 0;
        this.stepsWaited = 0;
        this.yStepsNext = false;
        this.stepTask.cancel();
    }

    write() {}

    read() {
        const buttons = this.held ? 0 : this.buttons;
        let pins = ~(buttons << ButtonsShift) & 0xff;
        if (!directionLevel(this.x.phase)) pins &= ~X2;
        if (!directionLevel(this.y.phase)) pins &= ~Y2;
        return pins;
    }

    /**
     * Moves the mouse `dx` quadrature steps right and `dy` up, four to each count the software sees, on top of any
     * movement it has still to make.
     */
    move(dx, dy) {
        if (this.held) return;
        this.inputLog?.record({ kind: "amxMove", dx, dy });
        this.x.pending += dx;
        this.y.pending += dy;
        this.stepTask.ensureScheduled(true, StepTicks);
    }

    /** @param {number} buttons the AmxButtons held */
    setButtons(buttons) {
        if (buttons === this.buttons) return;
        this.buttons = buttons;
        this.inputLog?.record({ kind: "amxButtons", buttons });
        this.via.recalculatePortBPins();
    }

    /** @param {boolean} held whether the mouse takes no further movement and reads its buttons up, whatever the host does */
    hold(held) {
        this.held = held;
        this.via.recalculatePortBPins();
    }

    /**
     * Each step moves one axis, taking turns while both have further to go so that a diagonal goes diagonally. It waits until the software has cleared the CB1 and CB2 flags, as BeebEm and b-em
     * wait, so that no edge on CB1 comes with one on CB2: J.G. Harston's driver reads only X when both flags are set.
     * After an edge it waits a step more once they are clear, so that a driver that clears them before reading the
     * direction lines (as AMX Design's does) has read them by then.
     */
    _step() {
        if (this.via.ifr & (ViaCb1Flag | ViaCb2Flag)) {
            if (++this.stepsWaited > StalledSteps) {
                this.reset();
                return;
            }
        } else if (this.stepsWaited) {
            this.stepsWaited = 0;
        } else if (this.y.pending && (this.yStepsNext || !this.x.pending)) {
            this._stepAxis(this.y, this.setY1);
            this.yStepsNext = false;
        } else {
            this._stepAxis(this.x, this.setX1);
            this.yStepsNext = true;
        }
        if (this.x.pending || this.y.pending) this.stepTask.reschedule(StepTicks);
    }

    _stepAxis(axis, setLine) {
        const from = axis.phase;
        const step = Math.sign(axis.pending);
        axis.pending -= step;
        axis.phase = (from + step) & PhaseMask;
        if (lineLevel(from) === lineLevel(axis.phase)) {
            this.via.recalculatePortBPins();
            return;
        }
        setLine(lineLevel(axis.phase));
        this.stepsWaited = 1;
    }

    snapshotState() {
        return {
            x: { ...this.x },
            y: { ...this.y },
            stepsWaited: this.stepsWaited,
            yStepsNext: this.yStepsNext,
            stepTaskOffset: this.stepTask.offset(),
        };
    }

    restoreState(state) {
        this.x = { ...state.x };
        this.y = { ...state.y };
        this.stepsWaited = state.stepsWaited;
        this.yStepsNext = state.yStepsNext;
        this.stepTask.restoreOffset(state.stepTaskOffset);
    }
}

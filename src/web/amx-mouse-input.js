import { AmxButtons } from "../amx-mouse.js";

const CanvasPixelsAcross = 896;
const PicturePixelsAcross = 640;
const PictureGraphicsUnitsAcross = 1280;
// One step to a graphics unit: J.G. Harston's driver moves its pointer four units for each count, which is four steps.
// The pointer then keeps up with the host's.
const StepsAcrossScreen = (PictureGraphicsUnitsAcross * CanvasPixelsAcross) / PicturePixelsAcross;

/** @returns {number} the AmxButtons a MouseEvent's `buttons` holds: primary 1, secondary 2, auxiliary 4. */
function amxButtonsOf(domButtons) {
    return (
        (domButtons & 1 ? AmxButtons.left : 0) |
        (domButtons & 4 ? AmxButtons.middle : 0) |
        (domButtons & 2 ? AmxButtons.right : 0)
    );
}

/**
 * The host's mouse driving the AMX mouse by how far it moves, not where it is. A click on the screen locks the pointer
 * to it, so the host's pointer never runs out of screen, and that click presses nothing. Where the browser refuses the
 * lock, movement over the screen drives the mouse all the same, and the next click presses a button as it asks again.
 * The buttons go up as the lock is let go, as the host's button may then come up anywhere.
 */
export class AmxMouseInput {
    /**
     * @param {object} options
     * @param {import("../amx-mouse.js").AmxMouse} options.mouse
     * @param {HTMLElement} options.target - the element the pointer locks to, whose mouse events these are
     * @param {HTMLCanvasElement} options.screenCanvas - the screen, which movements are measured across
     */
    constructor({ mouse, target, screenCanvas }) {
        this.mouse = mouse;
        this.target = target;
        this.screenCanvas = screenCanvas;
        this.remainderX = 0;
        this.remainderY = 0;
        this.lockRefused = false;
        const document = target.ownerDocument;
        target.addEventListener("contextmenu", (evt) => evt.preventDefault());
        document.addEventListener("pointerlockerror", () => {
            this.lockRefused = true;
        });
        document.addEventListener("pointerlockchange", () => {
            if (this.locked) this.lockRefused = false;
            else this.mouse.setButtons(0);
        });
    }

    get locked() {
        return this.target.ownerDocument.pointerLockElement === this.target;
    }

    /** @param {MouseEvent} evt a mousemove, mousedown or mouseup on `target` */
    onMouseEvent(evt) {
        if (evt.type === "mousemove") {
            this._move(evt.movementX, evt.movementY);
            return;
        }
        if (evt.type === "mousedown" && !this.locked) {
            const pressesToo = this.lockRefused;
            this._lock();
            if (!pressesToo) return;
        }
        this.mouse.setButtons(amxButtonsOf(evt.buttons));
    }

    _lock() {
        // Older browsers return nothing and report a refusal as pointerlockerror; newer ones reject as well.
        this.target.requestPointerLock()?.catch(() => {
            this.lockRefused = true;
        });
    }

    _move(movementX, movementY) {
        const stepsPerPixel = StepsAcrossScreen / this.screenCanvas.getBoundingClientRect().width;
        const x = this.remainderX + movementX * stepsPerPixel;
        const y = this.remainderY - movementY * stepsPerPixel;
        const dx = Math.trunc(x);
        const dy = Math.trunc(y);
        this.remainderX = x - dx;
        this.remainderY = y - dy;
        if (dx || dy) this.mouse.move(dx, dy);
    }
}

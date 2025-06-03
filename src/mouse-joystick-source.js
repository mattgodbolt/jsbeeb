import { AnalogueSource } from "./analogue-source.js";

/**
 * Mouse-based joystick implementation of AnalogueSource
 * Maps mouse position relative to BBC display center to ADC channels
 */
export class MouseJoystickSource extends AnalogueSource {
    /**
     * Create a new MouseJoystickSource
     * @param {HTMLCanvasElement} canvas - The BBC display canvas element
     */
    constructor(canvas) {
        super();
        this.canvas = canvas;
        this.mouseX = 0.5; // Normalized position (0-1)
        this.mouseY = 0.5; // Normalized position (0-1)
        this.isActive = false;
        this.via = null; // Will be set later
    }

    /**
     * Set the VIA reference for button handling
     * @param {object} via - The system VIA
     */
    setVia(via) {
        this.via = via;
    }

    /**
     * Handle mouse movement event from external handler
     * @param {number} x - Normalized X position (0-1)
     * @param {number} y - Normalized Y position (0-1)
     */
    onMouseMove(x, y) {
        this.mouseX = Math.max(0, Math.min(1, x));
        this.mouseY = Math.max(0, Math.min(1, y));
        this.isActive = true;
    }

    /**
     * Handle mouse button press from external handler
     * @param {number} button - Mouse button number (0 = left, 1 = middle, 2 = right)
     */
    onMouseDown(button) {
        if (!this.via) return;

        // Only handle left mouse button (button 0)
        if (button === 0) {
            this.via.setJoystickButton(0, true);
        }
    }

    /**
     * Handle mouse button release from external handler
     * @param {number} button - Mouse button number (0 = left, 1 = middle, 2 = right)
     */
    onMouseUp(button) {
        if (!this.via) return;

        // Only handle left mouse button (button 0)
        if (button === 0) {
            this.via.setJoystickButton(0, false);
        }
    }

    /**
     * Check if mouse joystick is enabled and ready
     * @returns {boolean} True if mouse joystick can handle events
     */
    isEnabled() {
        return !!this.via;
    }

    /**
     * Get analog value from mouse position for the specified channel
     * @param {number} channel - The ADC channel (0-3)
     * @returns {number} A value between 0 and 0xffff
     */
    getValue(channel) {
        switch (channel) {
            case 0:
                // X axis for joystick 1
                // BBC Micro: left=65535, right=0
                return Math.floor((1 - this.mouseX) * 0xffff);
            case 1:
                // Y axis for joystick 1
                // BBC Micro: up=65535, down=0
                return Math.floor((1 - this.mouseY) * 0xffff);
            case 2:
            case 3:
                // Joystick 2 axes (not used for mouse)
                return 0x8000;
            default:
                return 0x8000;
        }
    }

    /**
     * Clean up when source is no longer needed
     * Called by ADC when switching to a different source
     */
    dispose() {
        // Reset state
        this.via = null;
        this.isActive = false;
    }
}

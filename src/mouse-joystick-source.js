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

        // Bind event handlers
        this.handleMouseMove = this.handleMouseMove.bind(this);
        this.handleMouseEnter = this.handleMouseEnter.bind(this);
        this.handleMouseLeave = this.handleMouseLeave.bind(this);
        this.handleMouseDown = this.handleMouseDown.bind(this);
        this.handleMouseUp = this.handleMouseUp.bind(this);
        this.handleGlobalMouseMove = this.handleGlobalMouseMove.bind(this);

        // Attach event listeners
        this.canvas.addEventListener("mousemove", this.handleMouseMove);
        this.canvas.addEventListener("mouseenter", this.handleMouseEnter);
        this.canvas.addEventListener("mouseleave", this.handleMouseLeave);
        this.canvas.addEventListener("mousedown", this.handleMouseDown);
        this.canvas.addEventListener("mouseup", this.handleMouseUp);

        // Also listen to global mouse moves to track position even when not over canvas
        document.addEventListener("mousemove", this.handleGlobalMouseMove);
    }

    /**
     * Handle mouse movement over the canvas
     * @param {MouseEvent} event - The mouse event
     */
    handleMouseMove(event) {
        if (!this.isActive) return;

        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Normalize to 0-1 range
        this.mouseX = x / rect.width;
        this.mouseY = y / rect.height;

        // Clamp values
        this.mouseX = Math.max(0, Math.min(1, this.mouseX));
        this.mouseY = Math.max(0, Math.min(1, this.mouseY));
    }

    /**
     * Handle mouse entering the canvas
     */
    handleMouseEnter() {
        this.isActive = true;
    }

    /**
     * Handle mouse leaving the canvas
     */
    handleMouseLeave() {
        this.isActive = false;
        // Don't center when mouse leaves - keep last position
    }

    /**
     * Handle global mouse movement (even when not over canvas)
     * @param {MouseEvent} event - The mouse event
     */
    handleGlobalMouseMove(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        // Normalize to 0-1 range
        this.mouseX = x / rect.width;
        this.mouseY = y / rect.height;

        // Clamp values to 0-1 range
        this.mouseX = Math.max(0, Math.min(1, this.mouseX));
        this.mouseY = Math.max(0, Math.min(1, this.mouseY));
    }

    /**
     * Handle mouse button press
     * @param {MouseEvent} event - The mouse event
     */
    handleMouseDown(event) {
        if (!this.isActive || !this.via) return;

        // Only handle left mouse button (button 0)
        if (event.button === 0) {
            // Set fire button 1 pressed (PB4)
            this.via.setJoystickButton(0, true);
            event.preventDefault();
        }
    }

    /**
     * Handle mouse button release
     * @param {MouseEvent} event - The mouse event
     */
    handleMouseUp(event) {
        if (!this.via) return;

        // Only handle left mouse button (button 0)
        if (event.button === 0) {
            // Release fire button 1 (PB4)
            this.via.setJoystickButton(0, false);
            event.preventDefault();
        }
    }

    /**
     * Set the VIA reference for button handling
     * @param {object} via - The system VIA
     */
    setVia(via) {
        this.via = via;
    }

    /**
     * Get analog value from mouse position for the specified channel
     * @param {number} channel - The ADC channel (0-3)
     * @returns {number} A value between 0 and 0xffff
     */
    getValue(channel) {
        let value;

        // Use mouse position when enabled (always active when assigned to a channel)
        {
            switch (channel) {
                case 0:
                    // X axis for joystick 1
                    // BBC Micro: left=65535, right=0
                    // Convert from [0,1] to [0xffff,0] (inverted)
                    value = Math.floor((1 - this.mouseX) * 0xffff);
                    break;
                case 1:
                    // Y axis for joystick 1
                    // BBC Micro: up=65535, down=0
                    // Convert from [0,1] to [0xffff,0] (inverted)
                    value = Math.floor((1 - this.mouseY) * 0xffff);
                    break;
                case 2:
                    // X axis for joystick 2 (not used for mouse)
                    value = 0x8000;
                    break;
                case 3:
                    // Y axis for joystick 2 (not used for mouse)
                    value = 0x8000;
                    break;
                default:
                    value = 0x8000;
                    break;
            }
        }

        return value;
    }

    /**
     * Clean up event listeners when source is no longer needed
     */
    dispose() {
        this.canvas.removeEventListener("mousemove", this.handleMouseMove);
        this.canvas.removeEventListener("mouseenter", this.handleMouseEnter);
        this.canvas.removeEventListener("mouseleave", this.handleMouseLeave);
        this.canvas.removeEventListener("mousedown", this.handleMouseDown);
        this.canvas.removeEventListener("mouseup", this.handleMouseUp);
        document.removeEventListener("mousemove", this.handleGlobalMouseMove);
    }
}

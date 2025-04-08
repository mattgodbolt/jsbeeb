"use strict";

/**
 * SaveState class for jsbeeb.
 * Handles saving and restoring the emulator state.
 */
export class SaveState {
    /**
     * Create a new SaveState object
     * @param {Object} options - Options for the save state
     * @param {number} options.version - Version of the save state format
     */
    constructor(options = {}) {
        this.version = options.version || 1;
        this.timestamp = Date.now();
        this.components = new Map();
        this.metadata = {
            jsbeeb: "1.0", // Will be filled with actual version
            format: "jsbeeb-native",
        };
    }

    /**
     * Add a component's state to the save state
     * @param {string} componentName - Name of the component
     * @param {Object} componentState - State of the component
     */
    addComponent(componentName, componentState) {
        this.components.set(componentName, componentState);
    }

    /**
     * Get a component's state from the save state
     * @param {string} componentName - Name of the component
     * @returns {Object} Component state or undefined if not found
     */
    getComponent(componentName) {
        return this.components.get(componentName);
    }

    /**
     * Serialize the save state to a string
     * @param {Object} options - Serialization options
     * @param {boolean} options.pretty - Whether to format the JSON nicely
     * @returns {string} Serialized save state
     */
    serialize(options = {}) {
        const state = {
            version: this.version,
            timestamp: this.timestamp,
            metadata: this.metadata,
            components: Object.fromEntries(this.components),
        };

        // Convert typed arrays to base64
        const jsonString = JSON.stringify(
            state,
            (key, value) => {
                if (ArrayBuffer.isView(value)) {
                    return {
                        type: value.constructor.name,
                        data: this._arrayToBase64(value),
                    };
                }
                return value;
            },
            options.pretty ? 2 : undefined,
        );

        return jsonString;
    }

    /**
     * Deserialize a save state from a string
     * @param {string} data - Serialized save state
     * @returns {SaveState} Deserialized save state
     */
    static deserialize(data) {
        const parsed = JSON.parse(data, (key, value) => {
            if (value && typeof value === "object" && value.type && value.data) {
                if (value.type.includes("Array")) {
                    return SaveState._base64ToArray(value.data, value.type);
                }
            }
            return value;
        });

        const state = new SaveState({ version: parsed.version });
        state.timestamp = parsed.timestamp;
        state.metadata = parsed.metadata;

        // Convert from object to Map
        for (const [key, value] of Object.entries(parsed.components)) {
            state.components.set(key, value);
        }

        return state;
    }

    /**
     * Convert a save state to a compact format for storage
     * @returns {string} Compact serialized state
     */
    toCompactString() {
        // For now, just use standard serialization
        // In the future, this could use more efficient encoding or compression
        return this.serialize();
    }

    /**
     * Create a SaveState from a compact string
     * @param {string} data - Compact serialized state
     * @returns {SaveState} Deserialized save state
     */
    static fromCompactString(data) {
        // For now, just use standard deserialization
        return SaveState.deserialize(data);
    }

    /**
     * Convert an array buffer view to a base64 string
     * @private
     * @param {ArrayBufferView} array - Array to convert
     * @returns {string} Base64 encoded string
     */
    _arrayToBase64(array) {
        const binary = [];
        const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
        for (let i = 0; i < bytes.byteLength; i++) {
            binary.push(String.fromCharCode(bytes[i]));
        }
        return btoa(binary.join(""));
    }

    /**
     * Convert a base64 string to an array of the specified type
     * @private
     * @param {string} base64 - Base64 encoded string
     * @param {string} type - Array type (e.g., 'Uint8Array')
     * @returns {ArrayBufferView} Typed array
     */
    static _base64ToArray(base64, type) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        // Convert to the correct array type
        if (type === "Uint8Array") return bytes;
        if (type === "Int8Array") return new Int8Array(bytes.buffer);
        if (type === "Uint16Array") return new Uint16Array(bytes.buffer);
        if (type === "Int16Array") return new Int16Array(bytes.buffer);
        if (type === "Uint32Array") return new Uint32Array(bytes.buffer);
        if (type === "Int32Array") return new Int32Array(bytes.buffer);
        if (type === "Float32Array") return new Float32Array(bytes.buffer);
        if (type === "Float64Array") return new Float64Array(bytes.buffer);

        return bytes; // Default to Uint8Array
    }
}

/**
 * TimeTravel class for implementing rewind functionality
 */
export class TimeTravel {
    /**
     * Create a new TimeTravel object
     * @param {Object} options - Options for time travel
     * @param {number} options.bufferSize - Number of states to keep in the buffer
     * @param {number} options.captureInterval - Interval between state captures in milliseconds
     */
    constructor(options = {}) {
        this.bufferSize = options.bufferSize || 60; // Default: 60 states
        this.captureInterval = options.captureInterval || 1000; // Default: 1 second
        this.states = new Array(this.bufferSize);
        this.currentIndex = 0;
        this.count = 0;
        this.lastCaptureTime = 0;
    }

    /**
     * Add a state to the buffer
     * @param {SaveState} state - State to add
     */
    addState(state) {
        this.states[this.currentIndex] = state;
        this.currentIndex = (this.currentIndex + 1) % this.bufferSize;
        this.count = Math.min(this.count + 1, this.bufferSize);
    }

    /**
     * Get a state from the buffer
     * @param {number} stepsBack - Number of steps to go back
     * @returns {SaveState|null} The state or null if not available
     */
    getState(stepsBack) {
        if (stepsBack < 0 || stepsBack >= this.count) {
            return null;
        }

        const index = (this.currentIndex - stepsBack - 1 + this.bufferSize) % this.bufferSize;
        return this.states[index];
    }

    /**
     * Check if it's time to capture a new state
     * @param {number} currentTime - Current time in milliseconds
     * @returns {boolean} True if it's time to capture a state
     */
    shouldCapture(currentTime) {
        return currentTime - this.lastCaptureTime >= this.captureInterval;
    }

    /**
     * Mark a state as captured
     * @param {number} currentTime - Current time in milliseconds
     */
    markCaptured(currentTime) {
        this.lastCaptureTime = currentTime;
    }

    /**
     * Clear all states from the buffer
     */
    clear() {
        this.states = new Array(this.bufferSize);
        this.currentIndex = 0;
        this.count = 0;
        this.lastCaptureTime = 0;
    }
}

/**
 * SaveStateStorage class for managing save state storage
 */
export class SaveStateStorage {
    /**
     * Create a new SaveStateStorage object
     * @param {Object} options - Options for storage
     * @param {string} options.prefix - Prefix for localStorage keys
     */
    constructor(options = {}) {
        this.prefix = options.prefix || "jsbeeb_savestate_";
    }

    /**
     * Save a state to localStorage
     * @param {string} name - Name of the save slot
     * @param {SaveState} state - State to save
     * @returns {boolean} True if successful
     */
    saveToLocalStorage(name, state) {
        try {
            const key = this.prefix + name;
            const serialized = state.toCompactString();
            localStorage.setItem(key, serialized);

            // Update the list of save states
            this._updateSaveList(name);

            return true;
        } catch (e) {
            console.error("Failed to save state to localStorage:", e);
            return false;
        }
    }

    /**
     * Load a state from localStorage
     * @param {string} name - Name of the save slot
     * @returns {SaveState|null} The loaded state or null if not found
     */
    loadFromLocalStorage(name) {
        try {
            const key = this.prefix + name;
            const serialized = localStorage.getItem(key);

            if (!serialized) {
                return null;
            }

            return SaveState.fromCompactString(serialized);
        } catch (e) {
            console.error("Failed to load state from localStorage:", e);
            return null;
        }
    }

    /**
     * Delete a state from localStorage
     * @param {string} name - Name of the save slot
     * @returns {boolean} True if successful
     */
    deleteFromLocalStorage(name) {
        try {
            const key = this.prefix + name;
            localStorage.removeItem(key);

            // Update the list of save states
            this._updateSaveList(name, true);

            return true;
        } catch (e) {
            console.error("Failed to delete state from localStorage:", e);
            return false;
        }
    }

    /**
     * Get the list of saved states
     * @returns {string[]} List of save state names
     */
    getSaveList() {
        try {
            const listKey = this.prefix + "list";
            const list = localStorage.getItem(listKey);

            if (!list) {
                return [];
            }

            return JSON.parse(list);
        } catch (e) {
            console.error("Failed to get save list from localStorage:", e);
            return [];
        }
    }

    /**
     * Update the list of save states
     * @private
     * @param {string} name - Name of the save state
     * @param {boolean} remove - True to remove the state from the list
     */
    _updateSaveList(name, remove = false) {
        try {
            const listKey = this.prefix + "list";
            let list = this.getSaveList();

            if (remove) {
                list = list.filter((item) => item !== name);
            } else if (!list.includes(name)) {
                list.push(name);
            }

            localStorage.setItem(listKey, JSON.stringify(list));
        } catch (e) {
            console.error("Failed to update save list in localStorage:", e);
        }
    }
}

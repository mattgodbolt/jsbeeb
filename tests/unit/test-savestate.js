"use strict";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SaveState, TimeTravel, SaveStateStorage } from "../../src/savestate.js";

// Mock localStorage for testing
let mockLocalStorage = {};

// Sample component states to use in tests
const sampleCpuState = {
    registers: {
        a: 0x42,
        x: 0x55,
        y: 0xaa,
        s: 0xf0,
        pc: 0x1234,
    },
    flags: {
        c: true,
        z: false,
        i: true,
        d: false,
        v: false,
        n: true,
    },
    cycles: 123456789,
    memory: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
};

const sampleVideoState = {
    mode: 2,
    registers: new Uint8Array([0x7f, 0x50, 0x62, 0x28, 0x26, 0x00, 0x20, 0x22, 0x01, 0x07, 0x67, 0x08]),
    palette: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    cursorPosition: 0x0345,
    displayEnabled: true,
};

const sampleSoundState = {
    registers: new Uint8Array([0x01, 0x35, 0x06, 0x7f, 0x10, 0x27, 0x00, 0x0f]),
    tonePeriods: [1024, 512, 256, 128],
    volumeLevels: [15, 8, 4, 0],
};

describe("SaveState", () => {
    let saveState;

    beforeEach(() => {
        saveState = new SaveState();
    });

    it("should create a SaveState with default values", () => {
        expect(saveState.version).toBe(1);
        expect(saveState.components.size).toBe(0);
        expect(saveState.metadata.format).toBe("jsbeeb-native");
    });

    it("should allow adding and retrieving component states", () => {
        saveState.addComponent("cpu", sampleCpuState);
        saveState.addComponent("video", sampleVideoState);

        expect(saveState.getComponent("cpu")).toEqual(sampleCpuState);
        expect(saveState.getComponent("video")).toEqual(sampleVideoState);
        expect(saveState.getComponent("nonexistent")).toBeUndefined();
    });

    it("should serialize and deserialize correctly", () => {
        saveState.addComponent("cpu", sampleCpuState);
        saveState.addComponent("video", sampleVideoState);
        saveState.addComponent("sound", sampleSoundState);

        const serialized = saveState.serialize();
        const deserialized = SaveState.deserialize(serialized);

        // Check metadata
        expect(deserialized.version).toBe(saveState.version);
        expect(deserialized.timestamp).toBe(saveState.timestamp);
        expect(deserialized.metadata).toEqual(saveState.metadata);

        // Check components
        const cpu = deserialized.getComponent("cpu");
        expect(cpu.registers).toEqual(sampleCpuState.registers);
        expect(cpu.flags).toEqual(sampleCpuState.flags);
        expect(cpu.cycles).toBe(sampleCpuState.cycles);

        // Check typed arrays
        expect(cpu.memory instanceof Uint8Array).toBe(true);
        expect(Array.from(cpu.memory)).toEqual(Array.from(sampleCpuState.memory));

        const video = deserialized.getComponent("video");
        expect(video.mode).toBe(sampleVideoState.mode);
        expect(Array.from(video.registers)).toEqual(Array.from(sampleVideoState.registers));
        expect(Array.from(video.palette)).toEqual(Array.from(sampleVideoState.palette));
    });

    it("should handle various typed arrays correctly", () => {
        const typedArraysState = {
            uint8: new Uint8Array([1, 2, 3, 4]),
            int8: new Int8Array([-1, -2, -3, -4]),
            uint16: new Uint16Array([1000, 2000, 3000, 4000]),
            int16: new Int16Array([-1000, -2000, -3000, -4000]),
            uint32: new Uint32Array([100000, 200000, 300000, 400000]),
            int32: new Int32Array([-100000, -200000, -300000, -400000]),
            float32: new Float32Array([1.1, 2.2, 3.3, 4.4]),
            float64: new Float64Array([1.11, 2.22, 3.33, 4.44]),
        };

        saveState.addComponent("typedArrays", typedArraysState);

        const serialized = saveState.serialize();
        const deserialized = SaveState.deserialize(serialized);

        const restored = deserialized.getComponent("typedArrays");

        // Check each array type
        expect(restored.uint8 instanceof Uint8Array).toBe(true);
        expect(Array.from(restored.uint8)).toEqual(Array.from(typedArraysState.uint8));

        expect(restored.int8 instanceof Int8Array).toBe(true);
        expect(Array.from(restored.int8)).toEqual(Array.from(typedArraysState.int8));

        expect(restored.uint16 instanceof Uint16Array).toBe(true);
        expect(Array.from(restored.uint16)).toEqual(Array.from(typedArraysState.uint16));

        expect(restored.int16 instanceof Int16Array).toBe(true);
        expect(Array.from(restored.int16)).toEqual(Array.from(typedArraysState.int16));

        expect(restored.uint32 instanceof Uint32Array).toBe(true);
        expect(Array.from(restored.uint32)).toEqual(Array.from(typedArraysState.uint32));

        expect(restored.int32 instanceof Int32Array).toBe(true);
        expect(Array.from(restored.int32)).toEqual(Array.from(typedArraysState.int32));

        expect(restored.float32 instanceof Float32Array).toBe(true);
        // Use approximate equality for floating point
        expect(Array.from(restored.float32)).toEqual(
            expect.arrayContaining(Array.from(typedArraysState.float32).map((x) => expect.closeTo(x, 0.001))),
        );

        expect(restored.float64 instanceof Float64Array).toBe(true);
        expect(Array.from(restored.float64)).toEqual(
            expect.arrayContaining(Array.from(typedArraysState.float64).map((x) => expect.closeTo(x, 0.001))),
        );
    });

    it("should handle nested objects and arrays", () => {
        const complexState = {
            nested: {
                level1: {
                    level2: {
                        array: [1, 2, 3, 4],
                        typedArray: new Uint8Array([5, 6, 7, 8]),
                    },
                },
            },
            arrayOfObjects: [
                { id: 1, data: new Uint16Array([100, 200]) },
                { id: 2, data: new Uint16Array([300, 400]) },
            ],
        };

        saveState.addComponent("complex", complexState);

        const serialized = saveState.serialize();
        const deserialized = SaveState.deserialize(serialized);

        const restored = deserialized.getComponent("complex");

        // Check nested structure
        expect(restored.nested.level1.level2.array).toEqual([1, 2, 3, 4]);
        expect(Array.from(restored.nested.level1.level2.typedArray)).toEqual([5, 6, 7, 8]);

        // Check array of objects
        expect(restored.arrayOfObjects.length).toBe(2);
        expect(restored.arrayOfObjects[0].id).toBe(1);
        expect(Array.from(restored.arrayOfObjects[0].data)).toEqual([100, 200]);
        expect(restored.arrayOfObjects[1].id).toBe(2);
        expect(Array.from(restored.arrayOfObjects[1].data)).toEqual([300, 400]);
    });

    it("should support pretty printing with options", () => {
        saveState.addComponent("cpu", sampleCpuState);

        const compact = saveState.serialize();
        const pretty = saveState.serialize({ pretty: true });

        // Pretty version should be longer due to formatting
        expect(pretty.length).toBeGreaterThan(compact.length);

        // Both should deserialize to the same object
        const fromCompact = SaveState.deserialize(compact);
        const fromPretty = SaveState.deserialize(pretty);

        expect(fromCompact.getComponent("cpu")).toEqual(fromPretty.getComponent("cpu"));
    });
});

describe("TimeTravel", () => {
    let timeTravel;
    let currentTime;

    beforeEach(() => {
        timeTravel = new TimeTravel({
            bufferSize: 5,
            captureInterval: 1000,
        });

        // Mock date for consistent testing
        currentTime = 0;
        vi.spyOn(Date, "now").mockImplementation(() => currentTime);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should create a TimeTravel with the specified options", () => {
        expect(timeTravel.bufferSize).toBe(5);
        expect(timeTravel.captureInterval).toBe(1000);
        expect(timeTravel.states.length).toBe(5);
        expect(timeTravel.count).toBe(0);
    });

    it("should add states to the buffer", () => {
        const state1 = new SaveState();
        state1.addComponent("cpu", { ...sampleCpuState, cycles: 1000 });

        const state2 = new SaveState();
        state2.addComponent("cpu", { ...sampleCpuState, cycles: 2000 });

        timeTravel.addState(state1);
        expect(timeTravel.count).toBe(1);

        timeTravel.addState(state2);
        expect(timeTravel.count).toBe(2);
    });

    it("should maintain a circular buffer of states", () => {
        // Fill the buffer and then some
        for (let i = 0; i < 7; i++) {
            const state = new SaveState();
            state.addComponent("cpu", { ...sampleCpuState, cycles: i * 1000 });
            timeTravel.addState(state);
        }

        // Buffer size is 5, so we should have 5 states
        expect(timeTravel.count).toBe(5);

        // The oldest two states should be overwritten
        // We should have states with cycles 2000, 3000, 4000, 5000, 6000

        // Get the most recent state (0 steps back)
        const latest = timeTravel.getState(0);
        expect(latest.getComponent("cpu").cycles).toBe(6000);

        // Get the oldest state (4 steps back)
        const oldest = timeTravel.getState(4);
        expect(oldest.getComponent("cpu").cycles).toBe(2000);

        // Try to get a state beyond the buffer
        const tooOld = timeTravel.getState(5);
        expect(tooOld).toBeNull();
    });

    it("should track capture timing", () => {
        currentTime = 1000;

        // Should capture on first check
        expect(timeTravel.shouldCapture(currentTime)).toBe(true);

        timeTravel.markCaptured(currentTime);

        // Shouldn't capture right after capturing
        expect(timeTravel.shouldCapture(currentTime)).toBe(false);

        // Shouldn't capture before interval
        currentTime = 1500;
        expect(timeTravel.shouldCapture(currentTime)).toBe(false);

        // Should capture after interval
        currentTime = 2001;
        expect(timeTravel.shouldCapture(currentTime)).toBe(true);

        timeTravel.markCaptured(currentTime);
        expect(timeTravel.shouldCapture(currentTime)).toBe(false);
    });

    it("should clear all states", () => {
        // Add some states
        for (let i = 0; i < 3; i++) {
            const state = new SaveState();
            state.addComponent("cpu", { ...sampleCpuState, cycles: i * 1000 });
            timeTravel.addState(state);
        }

        expect(timeTravel.count).toBe(3);

        // Clear states
        timeTravel.clear();

        expect(timeTravel.count).toBe(0);
        expect(timeTravel.getState(0)).toBeNull();
    });
});

describe("SaveStateStorage", () => {
    let storage;

    beforeEach(() => {
        // Mock localStorage
        mockLocalStorage = {};

        Object.defineProperty(global, "localStorage", {
            value: {
                getItem: vi.fn((key) => mockLocalStorage[key] || null),
                setItem: vi.fn((key, value) => {
                    mockLocalStorage[key] = value;
                }),
                removeItem: vi.fn((key) => {
                    delete mockLocalStorage[key];
                }),
            },
            writable: true,
        });

        storage = new SaveStateStorage({ prefix: "test_" });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("should save a state to localStorage", () => {
        const state = new SaveState();
        state.addComponent("cpu", sampleCpuState);

        const result = storage.saveToLocalStorage("slot1", state);

        expect(result).toBe(true);
        expect(localStorage.setItem).toHaveBeenCalledTimes(2); // Once for state, once for list

        // Check list was updated
        expect(JSON.parse(mockLocalStorage["test_list"])).toContain("slot1");
    });

    it("should load a state from localStorage", () => {
        // Save a state first
        const state = new SaveState();
        state.addComponent("cpu", sampleCpuState);
        storage.saveToLocalStorage("slot1", state);

        // Load it back
        const loaded = storage.loadFromLocalStorage("slot1");

        expect(loaded).not.toBeNull();
        expect(loaded.version).toBe(state.version);
        expect(loaded.timestamp).toBe(state.timestamp);

        const loadedCpu = loaded.getComponent("cpu");
        expect(loadedCpu.registers).toEqual(sampleCpuState.registers);
        expect(loadedCpu.flags).toEqual(sampleCpuState.flags);
    });

    it("should return null when loading a non-existent state", () => {
        const result = storage.loadFromLocalStorage("nonexistent");

        expect(result).toBeNull();
    });

    it("should delete a state from localStorage", () => {
        // Save a state first
        const state = new SaveState();
        storage.saveToLocalStorage("slot1", state);

        // Delete it
        const result = storage.deleteFromLocalStorage("slot1");

        expect(result).toBe(true);
        expect(localStorage.removeItem).toHaveBeenCalledWith("test_slot1");

        // Check list was updated
        expect(JSON.parse(mockLocalStorage["test_list"])).not.toContain("slot1");
    });

    it("should get the list of saved states", () => {
        // Save a few states
        const state = new SaveState();
        storage.saveToLocalStorage("slot1", state);
        storage.saveToLocalStorage("slot2", state);
        storage.saveToLocalStorage("slot3", state);

        const list = storage.getSaveList();

        expect(list).toEqual(expect.arrayContaining(["slot1", "slot2", "slot3"]));
        expect(list.length).toBe(3);
    });

    it("should handle localStorage errors gracefully", () => {
        // Mock localStorage to throw an error
        localStorage.setItem.mockImplementation(() => {
            throw new Error("Storage full");
        });

        const state = new SaveState();
        const result = storage.saveToLocalStorage("error", state);

        expect(result).toBe(false);
    });
});

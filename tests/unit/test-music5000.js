import { describe, it, expect, beforeEach, vi } from "vitest";
import { Music5000 } from "../../src/music5000.js";
import { SaveState } from "../../src/savestate.js";
import { createMockModel } from "./test-savestate.js";

describe("Music5000", () => {
    let music5000;
    const mockOnBuffer = vi.fn();

    beforeEach(() => {
        vi.resetAllMocks();
        music5000 = new Music5000(mockOnBuffer);
        // Initialize D2ATable which is normally done in reset
        let i = 0;
        for (let chord = 0; chord < 8; chord++) {
            let val = music5000.chordBase[chord];
            for (let step = 0; step < 16; step++) {
                music5000.D2ATable[i] = Math.floor(val * 4);
                val += music5000.stepInc[chord];
                i++;
            }
        }
    });

    describe("saveState", () => {
        it("should save all necessary state to the SaveState object", () => {
            // Set up some test state
            music5000.waveRam[0] = 0x42;
            music5000.phaseRam[0] = 0x1234;
            music5000.cycleCount = 100;
            music5000.curCh = 3;
            music5000.activeRegSet = 1;
            music5000.sampleLeft = 123;
            music5000.sampleRight = 456;
            music5000.position = 10;

            // Create a SaveState
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Call saveState
            music5000.saveState(saveState);

            // Verify the component was added to the SaveState
            const state = saveState.getComponent("music5000");
            expect(state).toBeDefined();

            // Verify all properties were saved
            expect(state.waveRam).toBe(music5000.waveRam);
            expect(state.phaseRam).toBe(music5000.phaseRam);
            expect(state.cycleCount).toBe(100);
            expect(state.curCh).toBe(3);
            expect(state.activeRegSet).toBe(1);
            expect(state.sampleLeft).toBe(123);
            expect(state.sampleRight).toBe(456);
            expect(state.position).toBe(10);
            expect(state.D2ATable).toBe(music5000.D2ATable);
        });
    });

    describe("loadState", () => {
        it("should load all state from the SaveState object", () => {
            // Create a SaveState
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Create test data
            const testWaveRam = new Uint8Array(2048);
            testWaveRam[0] = 0x42;
            testWaveRam[100] = 0x55;

            const testPhaseRam = new Uint32Array(16);
            testPhaseRam[0] = 0x12345678;
            testPhaseRam[5] = 0x87654321;

            const testD2ATable = new Uint16Array(128);
            testD2ATable[0] = 100;
            testD2ATable[64] = 500;

            // Add component state to SaveState
            saveState.addComponent("music5000", {
                waveRam: testWaveRam,
                phaseRam: testPhaseRam,
                cycleCount: 200,
                curCh: 5,
                activeRegSet: 1,
                sampleLeft: 789,
                sampleRight: 1012,
                position: 15,
                D2ATable: testD2ATable,
            });

            // Call loadState
            music5000.loadState(saveState);

            // Verify state was loaded correctly
            expect(music5000.waveRam).toBe(testWaveRam);
            expect(music5000.phaseRam).toBe(testPhaseRam);
            expect(music5000.cycleCount).toBe(200);
            expect(music5000.curCh).toBe(5);
            expect(music5000.activeRegSet).toBe(1);
            expect(music5000.sampleLeft).toBe(789);
            expect(music5000.sampleRight).toBe(1012);
            expect(music5000.position).toBe(15);
            expect(music5000.D2ATable).toBe(testD2ATable);

            // Verify sampleBuffer was re-initialized
            expect(music5000.sampleBuffer).toBeInstanceOf(Float64Array);
            expect(music5000.sampleBuffer.length).toBe(256); // AUDIO_BUFFER_SIZE
        });

        it("should do nothing if the component is not in the SaveState", () => {
            // Create a SaveState with no music5000 component
            const mockModel = createMockModel();
            const saveState = new SaveState(mockModel);

            // Set initial state to check it doesn't change
            music5000.waveRam[0] = 0x42;
            music5000.cycleCount = 100;

            // Call loadState
            music5000.loadState(saveState);

            // Verify state was not changed
            expect(music5000.waveRam[0]).toBe(0x42);
            expect(music5000.cycleCount).toBe(100);
        });
    });
});

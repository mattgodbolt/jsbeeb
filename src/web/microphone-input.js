import { AnalogueSource } from "../analogue-source.js";
import { createAudioContext } from "./audio-utils.js";

const SilentLevel = 0;

/**
 * Provides microphone input as an analogue source for the BBC Micro's ADC
 * Used for software like MicroMike that uses the analogue port for sound input
 */
export class MicrophoneInput extends AnalogueSource {
    /**
     * Create a new MicrophoneInput
     */
    constructor() {
        super();
        this.audioContext = null;
        this.microphoneStream = null;
        this.microphoneSource = null;
        this.microphoneAnalyser = null;
        this.microphoneDataArray = null;
        this.errorCallback = null;
        this.errorMessage = null;
        this.initialisePromise = null;
        this.disposeCount = 0;
    }

    /**
     * Set error callback function
     * @param {Function} callback - Function to call with error messages
     */
    setErrorCallback(callback) {
        this.errorCallback = callback;
    }

    /**
     * Initialise microphone access
     * @returns {Promise<boolean>} True if initialisation was successful, or it was already running
     */
    initialise() {
        if (this.microphoneAnalyser) return Promise.resolve(true);

        if (!this.initialisePromise) {
            const promise = this._initialise().finally(() => {
                if (this.initialisePromise === promise) this.initialisePromise = null;
            });
            this.initialisePromise = promise;
        }

        return this.initialisePromise;
    }

    async _initialise() {
        console.log("MicrophoneInput: Initialising microphone input");

        if (!this.audioContext) {
            try {
                console.log("MicrophoneInput: Creating audio context");
                this.audioContext = createAudioContext();
                if (!this.audioContext) {
                    this.errorMessage = "WebAudio is not available; could not create audio context";
                    console.error("MicrophoneInput:", this.errorMessage);
                    if (this.errorCallback) this.errorCallback(this.errorMessage);
                    return false;
                }
                console.log("MicrophoneInput: Audio context created:", this.audioContext.state);
            } catch (error) {
                console.error("MicrophoneInput: Error creating audio context:", error);
                this.errorMessage = `Could not create audio context: ${error.message}`;
                if (this.errorCallback) this.errorCallback(this.errorMessage);
                return false;
            }
        }

        const disposeCountBeforePrompt = this.disposeCount;
        try {
            console.log("MicrophoneInput: Requesting microphone access");
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            if (this.disposeCount !== disposeCountBeforePrompt) {
                stream.getTracks().forEach((track) => track.stop());
                return false;
            }
            console.log("MicrophoneInput: Microphone access granted");

            this.microphoneStream = stream;

            console.log("MicrophoneInput: Creating audio analyser");
            this.microphoneAnalyser = this.audioContext.createAnalyser();
            this.microphoneAnalyser.fftSize = 1024;
            this.microphoneAnalyser.smoothingTimeConstant = 0.2;

            this.microphoneDataArray = new Uint8Array(this.microphoneAnalyser.frequencyBinCount);
            console.log("MicrophoneInput: Created data buffer with", this.microphoneDataArray.length, "samples");

            console.log("MicrophoneInput: Creating media stream source");
            this.microphoneSource = this.audioContext.createMediaStreamSource(stream);

            console.log("MicrophoneInput: Connecting microphone to analyser");
            this.microphoneSource.connect(this.microphoneAnalyser);

            this.errorMessage = null;
            console.log("MicrophoneInput: Initialisation complete");
            return true;
        } catch (error) {
            if (this.disposeCount !== disposeCountBeforePrompt) return false;
            console.error("MicrophoneInput: Error accessing microphone:", error);
            this.errorMessage = `Error accessing microphone: ${error.message}`;
            if (this.errorCallback) this.errorCallback(this.errorMessage);
            return false;
        }
    }

    /**
     * Get the last error message if any
     * @returns {string|null} The last error message or null
     */
    getErrorMessage() {
        return this.errorMessage;
    }

    /**
     * Get analog value from microphone for the specified channel
     * @param {number} _channel - The ADC channel (0-3)
     * @returns {number} A value between 0 and 0xffff
     */
    getValue(_channel) {
        // The ADC is routed here as soon as the channel is chosen, before access is granted.
        if (!this.microphoneAnalyser) return SilentLevel;

        // Get time domain data (waveform)
        this.microphoneAnalyser.getByteTimeDomainData(this.microphoneDataArray);

        // Calculate volume as average deviation from the center (128)
        let sum = 0;
        for (let i = 0; i < this.microphoneDataArray.length; i++) {
            sum += Math.abs(this.microphoneDataArray[i] - 128);
        }

        const average = sum / this.microphoneDataArray.length;

        // Scale up the signal using a configurable scaling factor
        // This can be adjusted based on testing
        const scaleFactor = 800; // Amplify the signal
        const scaledValue = average * scaleFactor;

        // Map to 16-bit range (0-0xFFFF)
        return Math.min(0xffff, scaledValue) | 0;
    }

    /**
     * Clean up resources when no longer needed
     */
    dispose() {
        this.disposeCount++;
        this.initialisePromise = null;
        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach((track) => track.stop());
            this.microphoneStream = null;
        }

        if (this.microphoneSource) {
            this.microphoneSource.disconnect();
            this.microphoneSource = null;
        }

        this.microphoneAnalyser = null;
        this.microphoneDataArray = null;

        if (this.audioContext && this.audioContext.state !== "closed") {
            this.audioContext.close().catch((err) => console.error("Error closing audio context:", err));
        }
        this.audioContext = null;
    }
}

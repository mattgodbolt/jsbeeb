import { AnalogueSource } from "./analogue-source.js";

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
     * @returns {Promise<boolean>} True if initialiation was successful
     */
    async initialise() {
        console.log("MicrophoneInput: Initialising microphone input");

        // Create audio context if needed
        if (!this.audioContext) {
            try {
                console.log("MicrophoneInput: Creating audio context");
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                console.log("MicrophoneInput: Audio context created:", this.audioContext.state);
            } catch (error) {
                console.error("MicrophoneInput: Error creating audio context:", error);
                this.errorMessage = `Could not create audio context: ${error.message}`;
                if (this.errorCallback) this.errorCallback(this.errorMessage);
                return false;
            }
        }

        try {
            console.log("MicrophoneInput: Requesting microphone access");
            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log("MicrophoneInput: Microphone access granted");

            // Store the stream so we can stop it if needed
            this.microphoneStream = stream;

            // Create analyser node
            console.log("MicrophoneInput: Creating audio analyser");
            this.microphoneAnalyser = this.audioContext.createAnalyser();
            this.microphoneAnalyser.fftSize = 1024; // Larger FFT size for better resolution
            this.microphoneAnalyser.smoothingTimeConstant = 0.2; // Less smoothing for more responsive input

            // Create buffer for analyser data
            this.microphoneDataArray = new Uint8Array(this.microphoneAnalyser.frequencyBinCount);
            console.log("MicrophoneInput: Created data buffer with", this.microphoneDataArray.length, "samples");

            // Create media stream source from microphone
            console.log("MicrophoneInput: Creating media stream source");
            this.microphoneSource = this.audioContext.createMediaStreamSource(stream);

            // Connect microphone to analyser
            console.log("MicrophoneInput: Connecting microphone to analyser");
            this.microphoneSource.connect(this.microphoneAnalyser);

            this.errorMessage = null;
            console.log("MicrophoneInput: Initialisation complete");
            return true;
        } catch (error) {
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
        if (!this.microphoneAnalyser || !this.microphoneDataArray) {
            throw new Error("MicrophoneInput: getValue called but analyser not initialised");
        }

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

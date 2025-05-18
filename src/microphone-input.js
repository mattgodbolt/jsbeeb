import { AnalogueSource } from "./analogue-source.js";

/**
 * Provides microphone input as an analogue source for the BBC Micro's ADC
 * Used for software like MicroMike that uses the analogue port for sound input
 */
export class MicrophoneInput extends AnalogueSource {
    /**
     * Create a new MicrophoneInput
     * @param {number} channel - The ADC channel to use (default: 1)
     */
    constructor(channel = 1) {
        super();
        this.channel = channel; // Default to channel 1 as per issue comments
        this.audioContext = null;
        this.microphoneStream = null;
        this.microphoneSource = null;
        this.microphoneAnalyser = null;
        this.microphoneDataArray = null;
        this.enabled = false;
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
     * Set which channel the microphone input is on
     * @param {number} channel - The ADC channel (0-3)
     * @returns {boolean} True if the channel was set successfully
     */
    setChannel(channel) {
        if (channel >= 0 && channel <= 3) {
            this.channel = channel;
            return true;
        }
        return false;
    }

    /**
     * Get current channel
     * @returns {number} The current channel
     */
    getChannel() {
        return this.channel;
    }

    /**
     * Initialize microphone access
     * @returns {Promise<boolean>} True if initialization was successful
     */
    async initialize() {
        // Create audio context if needed
        if (!this.audioContext) {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (error) {
                this.errorMessage = `Could not create audio context: ${error.message}`;
                if (this.errorCallback) this.errorCallback(this.errorMessage);
                return false;
            }
        }

        try {
            // Request microphone access
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Store the stream so we can stop it if needed
            this.microphoneStream = stream;

            // Create analyser node
            this.microphoneAnalyser = this.audioContext.createAnalyser();
            this.microphoneAnalyser.fftSize = 256;

            // Create buffer for analyser data
            this.microphoneDataArray = new Uint8Array(this.microphoneAnalyser.frequencyBinCount);

            // Create media stream source from microphone
            this.microphoneSource = this.audioContext.createMediaStreamSource(stream);

            // Connect microphone to analyser
            this.microphoneSource.connect(this.microphoneAnalyser);

            this.enabled = true;
            this.errorMessage = null;
            return true;
        } catch (error) {
            this.errorMessage = `Error accessing microphone: ${error.message}`;
            if (this.errorCallback) this.errorCallback(this.errorMessage);
            return false;
        }
    }

    /**
     * Check if microphone is currently enabled
     * @returns {boolean} True if microphone is enabled
     */
    isEnabled() {
        return this.enabled;
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
     * @param {number} channel - The ADC channel (0-3)
     * @returns {number} A value between 0 and 0xffff
     */
    getValue(channel) {
        if (!this.enabled || channel !== this.channel || !this.microphoneAnalyser || !this.microphoneDataArray) {
            return 0x8000; // Default center value when not active
        }

        // Get time domain data (waveform)
        this.microphoneAnalyser.getByteTimeDomainData(this.microphoneDataArray);

        // Calculate volume as average deviation from the center (128)
        let sum = 0;
        for (let i = 0; i < this.microphoneDataArray.length; i++) {
            sum += Math.abs(this.microphoneDataArray[i] - 128);
        }

        const average = sum / this.microphoneDataArray.length;

        // Map to 16-bit range (0-0xFFFF)
        // The scaling factor might need adjustment based on testing
        return Math.min(0xffff, average * 64);
    }

    /**
     * Check if this source provides input for the specified channel
     * @param {number} channel - The ADC channel (0-3)
     * @returns {boolean} True if this source provides input for the channel
     */
    hasChannel(channel) {
        return this.enabled && channel === this.channel;
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
        this.enabled = false;

        if (this.audioContext && this.audioContext.state !== "closed") {
            this.audioContext.close().catch((err) => console.error("Error closing audio context:", err));
        }
        this.audioContext = null;
    }
}

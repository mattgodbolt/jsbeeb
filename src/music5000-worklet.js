const BUFFER_SIZE = 65536;

registerProcessor(
    "music5000",
    class extends AudioWorkletProcessor {
        constructor() {
            super();
            this.port.onmessage = this.onmessage.bind(this);

            this.sampleBuffer = new Float32Array(BUFFER_SIZE);
            this.readPosition = 0;
            this.writePosition = 0;
        }

        onmessage(event) {
            // Receive a new 128-byte sample from the audio processor and write to the FIFO buffer
            const { data } = event;
            const sample = new Float32Array(data);

            if (this.writePosition === BUFFER_SIZE) {
                this.writePosition = 0;
            }

            for (let i = 0; i < data.length; i++) {
                this.sampleBuffer[this.writePosition++] = sample[i] / 32768.0; // Conversion to a range -1 to +1
            }
        }

        process(inputs, outputs) {
            // Playback
            if (this.readPosition === BUFFER_SIZE) {
                this.readPosition = 0;
            }

            for (let i = 0; i < outputs[0][0].length; i++) {
                outputs[0][0][i] = this.sampleBuffer[this.readPosition++];
                outputs[0][1][i] = this.sampleBuffer[this.readPosition++];
            }

            return true;
        }
    },
);

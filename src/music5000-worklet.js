/* global sampleRate, registerProcessor, AudioWorkletProcessor */
import { StereoRing } from "./stereo-ring.js";

const StartLatencyMs = 20;
const MaxLatencyMs = 250;
const FullScale = 32768;

const framesFor = (ms) => Math.ceil((sampleRate * ms) / 1000);

registerProcessor(
    "music5000",
    class extends AudioWorkletProcessor {
        constructor() {
            super();
            this.ring = new StereoRing(framesFor(MaxLatencyMs), framesFor(StartLatencyMs));
            this.port.onmessage = (event) => this.ring.write(event.data, 1 / FullScale);
        }

        process(inputs, outputs) {
            this.ring.read(outputs[0][0], outputs[0][1]);
            return true;
        }
    },
);

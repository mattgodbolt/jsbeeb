/* global sampleRate, registerProcessor, AudioWorkletProcessor */
import { StereoRing } from "./stereo-ring.js";
import { ExcessLeadMs, MaxTargetLatencyMs, PersistentExcessSeconds, validTargetLatencyMs } from "./audio-latency.js";

const FullScale = 32768;
const CapacityMs = 2 * MaxTargetLatencyMs;

const framesFor = (ms) => Math.ceil((sampleRate * ms) / 1000);

class Music5000Processor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        this.ring = new StereoRing(framesFor(CapacityMs), {
            targetFrames: framesFor(validTargetLatencyMs(options?.processorOptions?.targetLatencyMs)),
            excessFrames: framesFor(ExcessLeadMs),
            persistentExcessFrames: framesFor(1000 * PersistentExcessSeconds),
        });
        this.commands = {
            samples: (m) => this.ring.write(m.samples, 1 / FullScale),
            setTargetLatency: (m) => this.ring.setTargetFrames(framesFor(validTargetLatencyMs(m.targetLatencyMs))),
        };
        this.port.onmessage = (event) => this.onMessage(event.data);
    }

    onMessage(message) {
        const command = this.commands[message.command];
        if (!command) throw new Error(`Unknown Music 5000 command ${message.command}`);
        command(message);
    }

    process(inputs, outputs) {
        this.ring.read(outputs[0][0], outputs[0][1]);
        return true;
    }
}

registerProcessor("music5000", Music5000Processor);

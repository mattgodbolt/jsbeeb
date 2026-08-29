/* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */
import { SoundChip, AtomSoundChip } from "../soundchip.js";
import { PolyphaseResampler } from "../resampler.js";
import {
    AudioOutputs,
    DefaultAudioOutput,
    ResamplerCutoffOfOutputRate,
    ResamplerTaps,
    outputStages,
} from "../audio-output.js";

const DefaultTargetLatencyMs = 1000 * (1 / 50); // One frame
const MaxTargetLatencyMs = 250;

// Smoothing rejects the producer's per-tick bursts; proportional only, as
// lead already integrates rate error; 0.05% authority covers clock skew
// without audibly bending pitch.
const LeadSmoothingTau = 0.5;
const ProportionalGain = 0.2;
const MaxAdjustFraction = 0.0005;

const isResync = (event) => event.state !== undefined || event.reset !== undefined;

// Renders the chip from its timestamped state changes, so a producer that
// falls behind leaves the chip sounding its current state (a stall) rather
// than silent; the missed time is skipped once the producer is ahead again.
class SoundChipProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        const {
            isAtom = false,
            cpuSpeed = 1000000,
            targetLatencyMs,
            audioOutput = DefaultAudioOutput,
            audioFilterFreq,
            audioFilterQ,
            speakerAmount,
        } = options?.processorOptions ?? {};
        this.chip = isAtom ? new AtomSoundChip(null, { cpuSpeed }) : new SoundChip(null);
        this.inputSampleRate = this.chip.soundchipFreq;
        this.samplesPerCycle = this.chip.samplesPerCycle;
        this.boardFilter = { filterHz: audioFilterFreq, filterQ: audioFilterQ, speakerAmount };
        this.setAudioOutput(audioOutput);
        this.resampler = new PolyphaseResampler(this.inputSampleRate, ResamplerCutoffOfOutputRate * sampleRate, {
            taps: ResamplerTaps,
        });

        this.events = [];
        this.eventsHead = 0;
        this.clock = 0;
        this.upTo = 0;
        this.stalled = true;
        this.stalls = 0;
        this.skippedMs = 0;
        this.minLeadMs = Infinity;

        this._phase = 0;
        this.smoothedLeadError = 0;
        this.setTargetLatency(targetLatencyMs);
        this.port.onmessage = (event) => this.onMessage(event.data);
        this.nextStats = 0;
    }

    onMessage(message) {
        switch (message.command) {
            case "produced":
                this.onProduced(message.upTo, message.events);
                break;
            case "setEnabled":
                this.chip.enabled = message.enabled;
                break;
            case "setTargetLatency":
                this.setTargetLatency(message.targetLatencyMs);
                break;
            case "setAudioOutput":
                this.setAudioOutput(message.audioOutput);
                break;
            case "setSpeakerAmount":
                this.setSpeakerAmount(message.speakerAmount);
                break;
            default:
                throw new Error(`Unknown sound command ${message.command}`);
        }
    }

    setAudioOutput(audioOutput) {
        this.audioOutput = audioOutput;
        this.outputFilters = outputStages(this.inputSampleRate, audioOutput, this.boardFilter);
    }

    setSpeakerAmount(speakerAmount) {
        if (speakerAmount === this.boardFilter.speakerAmount) return;
        this.boardFilter.speakerAmount = speakerAmount;
        if (this.audioOutput === AudioOutputs.speaker) this.setAudioOutput(this.audioOutput);
    }

    setTargetLatency(ms) {
        const valid = Number.isFinite(ms) && ms > 0;
        this.targetLatencyMs = valid ? Math.min(ms, MaxTargetLatencyMs) : DefaultTargetLatencyMs;
        this.targetLeadCycles = this._cycles(this.targetLatencyMs);
        this.smoothedLeadError = 0;
    }

    _cycles(ms) {
        return ((ms / 1000) * this.inputSampleRate) / this.samplesPerCycle;
    }

    _ms(cycles) {
        return (1000 * cycles * this.samplesPerCycle) / this.inputSampleRate;
    }

    leadMs() {
        return this._ms(this.upTo - this.clock);
    }

    // A resync (restore or reset) starts a new timeline; anything queued
    // before it belongs to the old one.
    onProduced(upTo, events) {
        let from = 0;
        for (let i = events.length - 1; i >= 0; --i) {
            if (isResync(events[i])) {
                from = i;
                this.events = [];
                this.eventsHead = 0;
                break;
            }
        }
        if (this.eventsHead > 0) {
            this.events = this.events.slice(this.eventsHead);
            this.eventsHead = 0;
        }
        for (let i = from; i < events.length; ++i) this.events.push(events[i]);
        this.upTo = upTo;
    }

    stats(sampleRatio) {
        if (currentTime < this.nextStats) return;
        this.nextStats = currentTime + 0.25;
        this.port.postMessage({
            sampleRate: sampleRate,
            inputSampleRate: this.inputSampleRate,
            stalls: this.stalls,
            skippedMs: this.skippedMs,
            leadMs: this.leadMs(),
            leadMinMs: this.minLeadMs,
            queuedEvents: this.events.length - this.eventsHead,
            sampleRatio: sampleRatio,
        });
        this.minLeadMs = Infinity;
    }

    _notify(event, count) {
        this.port.postMessage({ event, count });
    }

    _effectiveSampleRate(dtSeconds) {
        const error = this.upTo - this.clock - this.targetLeadCycles;
        const alpha = Math.min(1, dtSeconds / LeadSmoothingTau);
        this.smoothedLeadError += alpha * (error - this.smoothedLeadError);
        const adjustment = ProportionalGain * this.smoothedLeadError * this.samplesPerCycle;
        const maxAdjust = this.inputSampleRate * MaxAdjustFraction;
        return this.inputSampleRate + Math.min(maxAdjust, Math.max(-maxAdjust, adjustment));
    }

    _applyHead() {
        this.chip.applyEvent(this.events[this.eventsHead++]);
    }

    // Applies every queued change up to `cycle` at once and moves the clock
    // there, so the sound continues from the producer's state without a gap.
    _skipTo(cycle) {
        while (this.eventsHead < this.events.length && this.events[this.eventsHead].cycle <= cycle) this._applyHead();
        this.skippedMs += this._ms(cycle - this.clock);
        this.clock = cycle;
    }

    _restart() {
        const skipTo = this.upTo - this.targetLeadCycles;
        if (skipTo > this.clock) {
            this._notify("skip", this._ms(skipTo - this.clock));
            this._skipTo(skipTo);
        }
        this.stalled = false;
    }

    _stall(out, offset, length) {
        if (!this.stalled) {
            this.stalled = true;
            this.stalls++;
            this._notify("stall", 1);
        }
        this.chip.renderAt(this.clock, out, offset, length);
    }

    // Input samples before the next change of state: the head event, or
    // the producer's position, whichever the clock reaches first. A resync
    // takes effect at once, since it starts a new timeline.
    _samplesUntilNextChange() {
        const head = this.events[this.eventsHead];
        if (head !== undefined && isResync(head)) return 0;
        const boundary = head === undefined ? this.upTo : Math.min(head.cycle, this.upTo);
        return Math.floor((boundary - this.clock) * this.samplesPerCycle);
    }

    _renderInput(out, offset, length) {
        if (this.stalled) {
            this._stall(out, offset, length);
            return;
        }
        while (length > 0) {
            const n = Math.min(length, this._samplesUntilNextChange());
            if (n > 0) {
                this.chip.renderAt(this.clock, out, offset, n);
                this.clock += n / this.samplesPerCycle;
                offset += n;
                length -= n;
                continue;
            }
            const head = this.events[this.eventsHead];
            if (head === undefined) {
                this._stall(out, offset, length);
                return;
            }
            if (isResync(head)) this.clock = head.cycle;
            this._applyHead();
        }
    }

    process(inputs, outputs) {
        if (this.stalled && this.upTo - this.clock >= this.targetLeadCycles) this._restart();

        const channel = outputs[0][0];
        const effectiveSampleRate = this._effectiveSampleRate(channel.length / sampleRate);
        const sampleRatio = effectiveSampleRate / sampleRate;

        // The fractional read position carries across quanta, so consumption
        // averages exactly sampleRatio and the pitch never steps at a rounding
        // boundary.
        const end = this._phase + channel.length * sampleRatio;
        const numInputSamples = Math.floor(end);
        const resampler = this.resampler;
        resampler.reserve(numInputSamples);
        this._renderInput(resampler.buffer, resampler.inputOffset, numInputSamples);
        for (const filter of this.outputFilters)
            filter.process(resampler.buffer, resampler.inputOffset, numInputSamples);
        resampler.read(channel, this._phase, sampleRatio);
        resampler.commit();
        this._phase = end - numInputSamples;
        this.minLeadMs = Math.min(this.minLeadMs, this.leadMs());
        this.stats(sampleRatio);
        return true;
    }
}

registerProcessor("sound-chip-processor", SoundChipProcessor);

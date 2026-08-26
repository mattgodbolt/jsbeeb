import { FakeSoundChip, SoundChip, AtomSoundChip } from "../soundchip.js";
import { DdNoise, FakeDdNoise } from "../ddnoise.js";
import { RelayNoise, FakeRelayNoise } from "../relaynoise.js";
import { Music5000, FakeMusic5000 } from "../music5000.js";
import { createAudioContext } from "../audio-utils.js";
import { toggle, fadeIn, fadeOut } from "../dom-utils.js";
import { toast } from "./toast.js";

// The renderer imports the sound chip, so it is bundled as a worker; a plain
// URL copies a worklet verbatim, which is fine for one with no imports and is
// what keeps vite happy when jsbeeb is embedded in other projects
// (https://github.com/vitejs/vite/discussions/6459).
import rendererUrl from "./audio-renderer.js?worker&url";
const music5000WorkletUrl = new URL("../music5000-worklet.js", import.meta.url).href;

// Skips plot as the milliseconds skipped, on the lead scale; stalls as a fixed spike.
const StallSpikeHeight = 20;

// Nobody is watching an unfocused window, so its sound can run far behind
// the picture, deep enough to ride out the browser starving the tab.
export const UnfocusedLatencyMs = 200;
export const DefaultLatencyMs = 20;

export class AudioHandler {
    constructor({
        warningNode,
        statsNode,
        audioFilterFreq,
        audioFilterQ,
        audioLatencyMs,
        noSeek,
        cpuSpeed,
        isAtom,
    } = {}) {
        this.cpuSpeed = cpuSpeed;
        this.isAtom = isAtom;
        this.audioLatencyMs = audioLatencyMs ?? DefaultLatencyMs;
        this.windowFocused = document.hasFocus();
        this.warningNode = warningNode;
        this.noAudio = false;
        toggle(this.warningNode, false);
        this.stats = {};
        this.eventCounts = { stall: 0, skip: 0, leadMinMs: Infinity };
        this._chipEvents = [];
        if (statsNode) {
            this._initStats(statsNode).catch((error) => {
                console.error("Unable to initialise audio stats", error);
                this.stats = {};
                toggle(statsNode, false);
            });
        }
        this.audioContext = createAudioContext();
        this._jsAudioNode = null;
        if (this.audioContext && this.audioContext.audioWorklet) {
            this.audioContext.onstatechange = () => this.checkStatus();
            const onEvent = (event) => this._chipEvents.push(event);
            this.soundChip = this.isAtom
                ? new AtomSoundChip(null, { cpuSpeed: this.cpuSpeed, onEvent })
                : new SoundChip(null, { onEvent });
            // Master gain node for all sample-based audio (disc, relay, etc.).
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
            this.ddNoise = noSeek ? new FakeDdNoise() : new DdNoise(this.audioContext, this.masterGain);
            this.relayNoise = new RelayNoise(this.audioContext, this.masterGain);
            this._setup(audioFilterFreq, audioFilterQ).catch((error) => this._audioUnavailable(error));
        } else {
            if (this.audioContext && !this.audioContext.audioWorklet) {
                this.audioContext = null;
                this.noAudio = true;
                console.log("Unable to initialise audio: no audio worklet API");
                const localhost = new URL(window.location);
                localhost.hostname = "localhost";
                this.warningNode.innerHTML = `No audio worklet API was found - there will be no audio.
                    If you are running a local jsbeeb, you must either use a host of
                    <a href="${localhost}">localhost</a>,
                    or serve the content over <em>https</em>.`;
                toggle(this.warningNode, true);
            }
            this.soundChip = new FakeSoundChip();
            this.ddNoise = new FakeDdNoise();
            this.relayNoise = new FakeRelayNoise();
        }

        this.warningNode.addEventListener("mousedown", () => this.tryResume());

        // Initialise Music 5000 audio context
        this.audioContextM5000 = createAudioContext({ sampleRate: 46875 });

        if (this.audioContextM5000 && this.audioContextM5000.audioWorklet) {
            this.audioContextM5000.onstatechange = () => this.checkStatus();
            this.music5000 = new Music5000((buffer) => this._onBufferMusic5000(buffer));

            this.audioContextM5000.audioWorklet
                .addModule(music5000WorkletUrl)
                .then(() => {
                    this._music5000workletnode = new AudioWorkletNode(this.audioContextM5000, "music5000", {
                        outputChannelCount: [2],
                    });
                    this._music5000workletnode.connect(this.audioContextM5000.destination);
                })
                .catch((error) => {
                    console.error("Unable to initialise Music 5000 audio", error);
                    toast(
                        `The Music 5000 will be silent: its audio could not be started (${error?.message ?? error}). Reloading the page may help.`,
                        { title: "Music 5000", quietKey: "quietMusic5000Audio" },
                    );
                });
        } else {
            this.music5000 = new FakeMusic5000();
        }
    }

    // Lazily load smoothie and set up the audio stats chart.
    async _initStats(statsNode) {
        const { SmoothieChart, TimeSeries } = await import("smoothie");
        this._TimeSeries = TimeSeries;
        this.chart = new SmoothieChart({
            tooltip: true,
            labels: { precision: 0 },
            yRangeFunction: (range) => {
                return { min: 0, max: range.max };
            },
        });
        this._addStat("leadMs", { strokeStyle: "rgb(51,126,108)" });
        this._addStat("stall", { strokeStyle: "rgb(220,50,50)", lineWidth: 2 });
        this._addStat("skip", { strokeStyle: "rgb(120,80,200)", lineWidth: 2 });
        this.chart.streamTo(statsNode, 100);
    }

    async _setup(audioFilterFreq, audioFilterQ) {
        await this.audioContext.audioWorklet.addModule(rendererUrl);
        if (audioFilterFreq !== 0) {
            const filterNode = this.audioContext.createBiquadFilter();
            filterNode.type = "lowpass";
            filterNode.frequency.value = audioFilterFreq;
            filterNode.Q.value = audioFilterQ;
            this._audioDestination = filterNode;
            filterNode.connect(this.audioContext.destination);
        } else {
            this._audioDestination = this.audioContext.destination;
        }

        this._jsAudioNode = new AudioWorkletNode(this.audioContext, "sound-chip-processor", {
            processorOptions: {
                targetLatencyMs: this._targetLatencyMs(),
                isAtom: this.isAtom,
                cpuSpeed: this.cpuSpeed,
            },
        });
        this._jsAudioNode.connect(this._audioDestination);
        this._jsAudioNode.port.onmessage = (event) => {
            const now = Date.now();
            if (event.data.event) {
                this._onAudioEvent(now, event.data);
                return;
            }
            this.eventCounts.leadMinMs = Math.min(this.eventCounts.leadMinMs, event.data.leadMinMs);
            for (const stat of Object.keys(event.data)) {
                if (this.stats[stat]) this.stats[stat].append(now, event.data[stat]);
            }
        };
    }

    _onAudioEvent(now, { event, count }) {
        this.eventCounts[event] += count;
        const series = this.stats[event];
        if (!series) return;
        series.append(now - 1, 0);
        series.append(now, event === "stall" ? StallSpikeHeight : count);
        series.append(now + 1, 0);
    }

    _targetLatencyMs() {
        return this.windowFocused ? this.audioLatencyMs : UnfocusedLatencyMs;
    }

    // Returns how far ahead of the sound the picture should now run, in ms.
    setWindowFocused(focused) {
        this.windowFocused = focused;
        const targetLatencyMs = this._targetLatencyMs();
        this._jsAudioNode?.port.postMessage({ command: "setTargetLatency", targetLatencyMs });
        return targetLatencyMs - this.audioLatencyMs;
    }

    takeEventCounts() {
        const counts = this.eventCounts;
        this.eventCounts = { stall: 0, skip: 0, leadMinMs: Infinity };
        return counts;
    }

    _audioUnavailable(error) {
        console.error("Unable to initialise audio", error);
        this.noAudio = true;
        this.warningNode.textContent = `There will be no sound: the audio system could not be started (${error?.message ?? error}). Reloading the page may help.`;
        fadeIn(this.warningNode);
    }

    _addStat(stat, info) {
        const timeSeries = new this._TimeSeries();
        this.stats[stat] = timeSeries;
        info.tooltipLabel = stat;
        this.chart.addTimeSeries(timeSeries, info);
    }

    // Ships the chip's state changes since the last call, and how far the
    // emulator has got, so the worklet knows its lead even when nothing changed.
    flushChipEvents() {
        if (!this._jsAudioNode) return;
        this._jsAudioNode.port.postMessage({ upTo: this.soundChip.scheduler.epoch, events: this._chipEvents });
        this._chipEvents = [];
    }

    // Recent browsers, particularly Safari and Chrome, require a user interaction in order to enable sound playback.
    // Errors are swallowed — resume() can fail due to autoplay policy and callers can't do anything about it.
    async tryResume() {
        try {
            if (this.audioContext) await this.audioContext.resume();
            if (this.audioContextM5000) await this.audioContextM5000.resume();
        } catch {
            // Autoplay policy prevented resume; will retry on next user gesture.
        }
    }

    _onBufferMusic5000(buffer) {
        if (this._music5000workletnode) this._music5000workletnode.port.postMessage(buffer);
    }

    checkStatus() {
        if (this.noAudio) return;
        if (!this.audioContext && !this.audioContextM5000) return;
        const suspended =
            (this.audioContext && this.audioContext.state === "suspended") ||
            (this.audioContextM5000 && this.audioContextM5000.state === "suspended");
        if (suspended) fadeIn(this.warningNode);
        else fadeOut(this.warningNode);
    }

    async initialise() {
        await this.ddNoise.initialise();
        await this.relayNoise.initialise();
    }

    // The emulator is stopping, so no tick will ship the change; send it now.
    mute() {
        this.soundChip.mute();
        this.flushChipEvents();
        if (this.masterGain) this.masterGain.gain.value = 0;
    }

    unmute() {
        this.soundChip.unmute();
        this.flushChipEvents();
        if (this.masterGain) this.masterGain.gain.value = 1;
    }
}

import { FakeSoundChip, SoundChip } from "../soundchip.js";
import { DdNoise, FakeDdNoise } from "../ddnoise.js";
import { RelayNoise, FakeRelayNoise } from "../relaynoise.js";
import { Music5000, FakeMusic5000 } from "../music5000.js";
import { createAudioContext } from "../audio-utils.js";
import { toggle, fadeIn, fadeOut } from "../dom-utils.js";

// Using this approach means when jsbeeb is embedded in other projects, vite doesn't have a fit.
// See https://github.com/vitejs/vite/discussions/6459
const rendererUrl = new URL("./audio-renderer.js", import.meta.url).href;
const music5000WorkletUrl = new URL("../music5000-worklet.js", import.meta.url).href;

export class AudioHandler {
    constructor({ warningNode, statsNode, audioFilterFreq, audioFilterQ, noSeek } = {}) {
        this.warningNode = warningNode;
        toggle(this.warningNode, false);
        this.stats = {};
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
            this.soundChip = new SoundChip((buffer, time) => this._onBuffer(buffer, time));
            // Master gain node for all sample-based audio (disc, relay, etc.).
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
            this.ddNoise = noSeek ? new FakeDdNoise() : new DdNoise(this.audioContext, this.masterGain);
            this.relayNoise = new RelayNoise(this.audioContext, this.masterGain);
            this._setup(audioFilterFreq, audioFilterQ).then();
        } else {
            if (this.audioContext && !this.audioContext.audioWorklet) {
                this.audioContext = null;
                console.log("Unable to initialise audio: no audio worklet API");
                toggle(this.warningNode, true);
                const localhost = new URL(window.location);
                localhost.hostname = "localhost";
                this.warningNode.innerHTML = `No audio worklet API was found - there will be no audio.
                    If you are running a local jsbeeb, you must either use a host of
                    <a href="${localhost}">localhost</a>,
                    or serve the content over <em>https</em>.`;
            }
            this.soundChip = new FakeSoundChip();
            this.ddNoise = new FakeDdNoise();
            this.relayNoise = new FakeRelayNoise();
        }

        this.warningNode.addEventListener("mousedown", () => this.tryResume());
        toggle(this.warningNode, false);

        // Initialise Music 5000 audio context
        this.audioContextM5000 = createAudioContext({ sampleRate: 46875 });

        if (this.audioContextM5000 && this.audioContextM5000.audioWorklet) {
            this.audioContextM5000.onstatechange = () => this.checkStatus();
            this.music5000 = new Music5000((buffer) => this._onBufferMusic5000(buffer));

            this.audioContextM5000.audioWorklet.addModule(music5000WorkletUrl).then(() => {
                this._music5000workletnode = new AudioWorkletNode(this.audioContextM5000, "music5000", {
                    outputChannelCount: [2],
                });
                this._music5000workletnode.connect(this.audioContextM5000.destination);
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
        this._addStat("queueSize", { strokeStyle: "rgb(51,126,108)" });
        this._addStat("queueAge", { strokeStyle: "rgb(162,119,22)" });
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

        this._jsAudioNode = new AudioWorkletNode(this.audioContext, "sound-chip-processor");
        this._jsAudioNode.connect(this._audioDestination);
        this._jsAudioNode.port.onmessage = (event) => {
            const now = Date.now();
            for (const stat of Object.keys(event.data)) {
                if (this.stats[stat]) this.stats[stat].append(now, event.data[stat]);
            }
        };
    }

    _addStat(stat, info) {
        const timeSeries = new this._TimeSeries();
        this.stats[stat] = timeSeries;
        info.tooltipLabel = stat;
        this.chart.addTimeSeries(timeSeries, info);
    }

    _onBuffer(buffer) {
        if (this._jsAudioNode) this._jsAudioNode.port.postMessage({ time: Date.now(), buffer }, [buffer.buffer]);
    }

    // Recent browsers, particularly Safari and Chrome, require a user interaction in order to enable sound playback.
    async tryResume() {
        if (this.audioContext) await this.audioContext.resume();
        if (this.audioContextM5000) await this.audioContextM5000.resume();
    }

    _onBufferMusic5000(buffer) {
        if (this._music5000workletnode) this._music5000workletnode.port.postMessage(buffer);
    }

    checkStatus() {
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

    mute() {
        this.soundChip.mute();
        if (this.masterGain) this.masterGain.gain.value = 0;
    }

    unmute() {
        this.soundChip.unmute();
        if (this.masterGain) this.masterGain.gain.value = 1;
    }
}

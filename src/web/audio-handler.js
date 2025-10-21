import { SmoothieChart, TimeSeries } from "smoothie";
import { FakeSoundChip, SoundChip } from "../soundchip.js";
import { DdNoise, FakeDdNoise } from "../ddnoise.js";
import { Music5000, FakeMusic5000 } from "../music5000.js";

// Using this approach means when jsbeeb is embedded in other projects, vite doesn't have a fit.
// See https://github.com/vitejs/vite/discussions/6459
const rendererUrl = new URL("./audio-renderer.js", import.meta.url).href;
const music5000WorkletUrl = new URL("../music5000-worklet.js", import.meta.url).href;

export class AudioHandler {
    constructor(warningNode, statsNode, audioFilterFreq, audioFilterQ, noSeek) {
        this.warningNode = warningNode;
        this.warningNode.toggle(false);
        this.chart = new SmoothieChart({
            tooltip: true,
            labels: { precision: 0 },
            yRangeFunction: (range) => {
                return { min: 0, max: range.max };
            },
        });
        this.stats = {};
        this._addStat("queueSize", { strokeStyle: "rgb(51,126,108)" });
        this._addStat("queueAge", { strokeStyle: "rgb(162,119,22)" });
        this.chart.streamTo(statsNode, 100);
        /*global webkitAudioContext*/
        this.audioContext =
            typeof AudioContext !== "undefined"
                ? new AudioContext()
                : typeof webkitAudioContext !== "undefined"
                  ? new webkitAudioContext()
                  : null;
        this._jsAudioNode = null;
        if (this.audioContext && this.audioContext.audioWorklet) {
            this.audioContext.onstatechange = () => this.checkStatus();
            this.soundChip = new SoundChip((buffer, time) => this._onBuffer(buffer, time));
            this.ddNoise = noSeek ? new FakeDdNoise() : new DdNoise(this.audioContext);
            this._setup(audioFilterFreq, audioFilterQ).then();
        } else {
            if (this.audioContext && !this.audioContext.audioWorklet) {
                this.audioContext = null;
                console.log("Unable to initialise audio: no audio worklet API");
                this.warningNode.toggle(true);
                const localhost = new URL(window.location);
                localhost.hostname = "localhost";
                this.warningNode.html(
                    `No audio worklet API was found - there will be no audio. 
                    If you are running a local jsbeeb, you must either use a host of
                    <a href="${localhost}">localhost</a>, 
                    or serve the content over <em>https</em>.`,
                );
            }
            this.soundChip = new FakeSoundChip();
            this.ddNoise = new FakeDdNoise();
        }

        this.warningNode.on("mousedown", () => this.tryResume());
        this.warningNode.toggle(false);

        // Initialise Music 5000 audio context
        this.audioContextM5000 =
            typeof AudioContext !== "undefined"
                ? new AudioContext({ sampleRate: 46875 })
                : typeof webkitAudioContext !== "undefined"
                  ? new webkitAudioContext({ sampleRate: 46875 })
                  : null;

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
        const timeSeries = new TimeSeries();
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
        if (!this.audioContext) return;
        if (this.audioContext.state === "suspended") this.warningNode.fadeIn();
        if (this.audioContext.state === "running") this.warningNode.fadeOut();
    }

    async initialise() {
        await this.ddNoise.initialise();
    }

    mute() {
        this.soundChip.mute();
        this.ddNoise.mute();
    }

    unmute() {
        this.soundChip.unmute();
        this.ddNoise.unmute();
    }
}

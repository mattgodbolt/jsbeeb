import {FakeSoundChip, SoundChip} from "../soundchip.js";
import {DdNoise, FakeDdNoise} from "../ddnoise.js";
import {AudioWorklet} from "audio-worklet";

export class AudioHandler {
    constructor(warningNode, audioFilterFreq, audioFilterQ, noSeek) {
        this.warningNode = warningNode;

        /*global webkitAudioContext*/
        this.audioContext = typeof AudioContext !== 'undefined' ? new AudioContext()
            : typeof webkitAudioContext !== 'undefined' ? new webkitAudioContext()
                : null;
        this._jsAudioNode = null;
        if (this.audioContext) {
            this.audioContext.onstatechange = () => this.checkStatus();
            this.soundChip = new SoundChip((buffer, time) => this._onBuffer(buffer, time));
            this.ddNoise = noSeek ? new FakeDdNoise() : new DdNoise(this.audioContext);
            this._setup(audioFilterFreq, audioFilterQ).then();
        } else {
            this.soundChip = new FakeSoundChip();
            this.ddNoise = new FakeDdNoise();
        }

        this.warningNode.on('mousedown', () => this.tryResume());
        this.warningNode.toggle(false);
    }

    async _setup(audioFilterFreq, audioFilterQ) {
        new Worker(new URL('./audio-renderer.js', import.meta.url));
        await this.audioContext.audioWorklet.addModule(
            new AudioWorklet(
                new URL("./audio-renderer.js", import.meta.url)
            )
        );
        if (audioFilterFreq !== 0) {
            this.soundChip.filterNode = this.audioContext.createBiquadFilter();
            this.soundChip.filterNode.type = "lowpass";
            this.soundChip.filterNode.frequency.value = audioFilterFreq;
            this.soundChip.filterNode.Q.value = audioFilterQ;
            this._audioDestination = this.soundChip.filterNode;
            this.soundChip.filterNode.connect(this.audioContext.destination);
        } else {
            this._audioDestination = this.audioContext.destination;
        }

        this._jsAudioNode = new AudioWorkletNode(this.audioContext, 'sound-chip-processor');
        this._jsAudioNode.connect(this._audioDestination);
    }

    _onBuffer(buffer) {
        if (this._jsAudioNode)
            this._jsAudioNode.port.postMessage({time: Date.now(), buffer}, [buffer.buffer]);
    }

    // Recent browsers, particularly Safari and Chrome, require a user
    // interaction in order to enable sound playback.
    async tryResume() {
        if (this.audioContext)
            await this.audioContext.resume();
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

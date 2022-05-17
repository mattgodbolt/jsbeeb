import {FakeSoundChip, SoundChip} from "../soundchip.js";
import {DdNoise, FakeDdNoise} from "../ddnoise.js";
import {Music5000, FakeMusic5000} from "../music5000.js";

export class AudioHandler {
    constructor(warningNode, audioFilterFreq, audioFilterQ, noSeek) {
        this.warningNode = warningNode;

        /*global webkitAudioContext*/
        this.audioContext = typeof AudioContext !== 'undefined' ? new AudioContext()
            : typeof webkitAudioContext !== 'undefined' ? new webkitAudioContext()
                : null;
        if (this.audioContext) {
            this.audioContext.onstatechange = () => this.checkStatus();
            // TODO: try and remove the dependency on this being created first? maybe? like, why should the soundchip
            //  care what renderer we have? Perhaps we can pick a sample rate and then use playback speed of the
            //  js audio node to match real time with the output.
            this.soundChip = new SoundChip(this.audioContext.sampleRate);
            this.ddNoise = noSeek ? new FakeDdNoise() : new DdNoise(this.audioContext);
            this._setup(audioFilterFreq, audioFilterQ);
        } else {
            this.soundChip = new FakeSoundChip();
            this.ddNoise = new FakeDdNoise();
        }

        this.warningNode.on('mousedown', () => this.tryResume());
        this.warningNode.toggle(false);

        // Initialise Music 5000 audio context
        this.audioContextM5000 = typeof AudioContext !== 'undefined' ? new AudioContext({sampleRate: 46875})
        : typeof webkitAudioContext !== 'undefined' ? new webkitAudioContext({sampleRate: 46875}) 
            : null;

        if (this.audioContextM5000 && this.audioContextM5000.audioWorklet) 
        {
            this.audioContextM5000.onstatechange = () => this.checkStatus();
            this.music5000 = new Music5000((buffer) => this._onBufferMusic5000(buffer));
         
            this.audioContextM5000.audioWorklet.addModule('./web/music5000-worklet.js').then(() => {
                this._music5000workletnode = new AudioWorkletNode(this.audioContextM5000, 'music5000', {outputChannelCount : [2]});
                this._music5000workletnode.connect(this.audioContextM5000.destination);
            });
        }
        else 
        {
            this.music5000 = new FakeMusic5000();
        }
    }

    _setup(audioFilterFreq, audioFilterQ) {
        // NB must be assigned to some kind of object else it seems to get GC'd by Safari...
        // TODO consider using a newer API. AudioWorkletNode? Harder to do two-way conversations there. Maybe needs
        //  a AudioBufferSourceNode and pingponging between buffers?
        this._jsAudioNode = this.audioContext.createScriptProcessor(2048, 0, 1);
        this._jsAudioNode.onaudioprocess = (event) => {
            const outBuffer = event.outputBuffer;
            const chan = outBuffer.getChannelData(0);
            this.soundChip.render(chan, 0, chan.length);
        };

        if (audioFilterFreq !== 0) {
            this.soundChip.filterNode = this.audioContext.createBiquadFilter();
            this.soundChip.filterNode.type = "lowpass";
            this.soundChip.filterNode.frequency.value = audioFilterFreq;
            this.soundChip.filterNode.Q.value = audioFilterQ;
            this._jsAudioNode.connect(this.soundChip.filterNode);
            this.soundChip.filterNode.connect(this.audioContext.destination);
        } else {
            this.soundChip._jsAudioNode.connect(this.audioContext.destination);
        }
    }
    // Recent browsers, particularly Safari and Chrome, require a user
    // interaction in order to enable sound playback.
    async tryResume() {
        if (this.audioContext)
            await this.audioContext.resume();
        if (this.audioContextM5000)
            await this.audioContextM5000.resume();
    }

    
    _onBufferMusic5000(buffer) {
        if (this._music5000workletnode)
            this._music5000workletnode.port.postMessage(buffer);
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

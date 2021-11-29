define(['./utils', 'underscore', 'promise'], function (utils, _) {
    "use strict";

    const VOLUME = 0.15;

    class KeyNoise {
        constructor(context) {
            this.context = context;
            this.genericKeyUps = [];
            this.genericKeyDowns = [];
            this.specialKeyUps = {};
            this.specialKeyDowns = {};
            this.gain = context.createGain();
            this.gain.gain.value = VOLUME;
            this.gain.connect(context.destination);
        }

        async loadSounds(sounds) {
            return await Promise.all(_.map(sounds, async sound => {
                // Safari doesn't support the Promise stuff directly, so we create our own Promise here.
                const data = await utils.loadData(sound);
                return new Promise((resolve, reject) => {
                    this.context.decodeAudioData(data.buffer, function (decodedData) {
                        resolve(decodedData);
                    });
                });
            }));
        }

        async initialise() {
            // TODO: make a list of samples here
            function samples(number, name){
              let a = []
              for (let i = 1; i <= number; i++) {a.push(i)}
              return a.map(k => 'sounds/keys/'+name+k+'.wav')
            }

            this.genericKeyUps = await this.loadSounds(samples(4,'keyUp'));
            this.genericKeyDowns = await this.loadSounds(samples(4,'keyDown'));
            // TODO: actually use different samples for special keys
            this.specialKeyUps[utils.BBC.SPACE] = await this.loadSounds(samples(4,'spaceUp'));
            this.specialKeyDowns[utils.BBC.SPACE] = await this.loadSounds(samples(4,'spaceDown'));
            this.specialKeyUps[utils.BBC.RETURN] = await this.loadSounds(samples(3,'returnUp'));
            this.specialKeyDowns[utils.BBC.RETURN] = await this.loadSounds(samples(3,'returnDown'));
        }

        _oneShot(sound) {
            const duration = sound.duration;
            const context = this.context;
            if (context.state !== "running") return duration;
            const source = context.createBufferSource();
            source.buffer = sound;
            source.connect(this.gain);
            source.start();
            return duration;
        }

        keyDown(colrow) {
            this._oneShot(_.sample(this.specialKeyDowns[colrow] || this.genericKeyDowns));
        }

        keyUp(colrow) {
            this._oneShot(_.sample(this.specialKeyUps[colrow] || this.genericKeyUps));
        }

        mute() {
            this.gain.gain.value = 0;
        }

        unmute() {
            this.gain.gain.value = VOLUME;
        }
    }

    class FakeKeyNoise {
        initialise() {
        }

        keyDown() {
        }

        keyUp() {
        }

        mute() {
        }

        unmute() {
        }
    }

    return {
        KeyNoise,
        FakeKeyNoise
    };
});

define(['./utils', 'underscore', 'promise'], function (utils, _) {
    "use strict";

    var IDLE = 0, SPIN_UP = 1, SPINNING = 2;
    var VOLUME = 0.25;

    function DdNoise(context) {
        this.context = context;
        this.sounds = {};
        this.state = IDLE;
        this.motor = null;
        this.gain = context.createGain();
        this.gain.gain.value = VOLUME;
        this.gain.connect(context.destination);
        // workaround for older safaris that GC sounds when they're playing...
        this.playing = [];
    }

    function loadSounds(context, sounds) {
        return Promise.all(_.map(sounds, function (sound) {
            // Safari doesn't support the Promise stuff directly, so we create
            // our own Promise here.
            return utils.loadData(sound).then(function (data) {
                return new Promise(function (resolve, reject) {
                    context.decodeAudioData(data.buffer, function (decodedData) {
                        resolve(decodedData);
                    });
                });
            });
        })).then(function (loaded) {
            var keys = _.keys(sounds);
            var result = {};
            for (var i = 0; i < keys.length; ++i) {
                result[keys[i]] = loaded[i];
            }
            return result;
        });
    }

    DdNoise.prototype.initialise = function () {
        var self = this;
        return loadSounds(self.context, {
            motorOn: 'sounds/disc525/motoron.wav',
            motorOff: 'sounds/disc525/motoroff.wav',
            motor: 'sounds/disc525/motor.wav',
            step: 'sounds/disc525/step.wav',
            seek: 'sounds/disc525/seek.wav',
            seek2: 'sounds/disc525/seek2.wav',
            seek3: 'sounds/disc525/seek3.wav'
        }).then(function (sounds) {
            self.sounds = sounds;
        });
    };

    DdNoise.prototype.oneShot = function (sound) {
        var duration = sound.duration;
        var context = this.context;
        if (context.state !== "running") return duration;
        var source = context.createBufferSource();
        source.buffer = sound;
        source.connect(this.gain);
        source.start();
        return duration;
    };

    DdNoise.prototype.play = function (sound, loop) {
        if (this.context.state !== "running") return Promise.reject();
        var self = this;
        return new Promise(function (resolve, reject) {
            var source = self.context.createBufferSource();
            source.loop = !!loop;
            source.buffer = sound;
            source.connect(self.gain);
            source.onended = function () {
                self.playing = _.without(self.playing, source);
                if (!source.loop) resolve();
            };
            source.start();
            self.playing.push(source);
            if (source.loop) {
                resolve(source);
            }
        });
    };

    DdNoise.prototype.spinUp = function () {
        if (this.state === SPINNING || this.state === SPIN_UP) return;
        this.state = SPIN_UP;
        var self = this;
        this.play(this.sounds.motorOn).then(function () {
            // Handle race: we may have had spinDown() called on us before the
            // spinUp() initial sound finished playing.
            if (self.state === IDLE) {
                return;
            }
            self.play(self.sounds.motor, true).then(function (source) {
                self.motor = source;
                self.state = SPINNING;
            });
        }, function () {});
    };

    DdNoise.prototype.spinDown = function () {
        if (this.state === IDLE) return;
        this.state = IDLE;
        if (this.motor) {
            this.motor.stop();
            this.motor = null;
            this.oneShot(this.sounds.motorOff);
        }
    };

    DdNoise.prototype.seek = function (diff) {
        if (diff < 0) diff = -diff;
        if (diff === 0) return 0;
        else if (diff === 1) return this.oneShot(this.sounds.step);
        else if (diff < 10) return this.oneShot(this.sounds.seek);
        else if (diff < 30) return this.oneShot(this.sounds.seek2);
        else return this.oneShot(this.sounds.seek3);
    };

    DdNoise.prototype.mute = function () {
        this.gain.gain.value = 0;
    };
    DdNoise.prototype.unmute = function () {
        this.gain.gain.value = VOLUME;
    };

    function FakeDdNoise() {
    }

    FakeDdNoise.prototype.spinUp = FakeDdNoise.prototype.spinDown =
        FakeDdNoise.prototype.mute = FakeDdNoise.prototype.unmute = utils.noop;
    FakeDdNoise.prototype.seek = function () {
        return 0;
    };
    FakeDdNoise.prototype.initialise = function () {
        return Promise.resolve();
    };

    return {
        DdNoise: DdNoise,
        FakeDdNoise: FakeDdNoise
    };
});

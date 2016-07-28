// Fakes out a 6502
define(['6502', 'video', 'soundchip', 'models', 'ddnoise', 'cmos'],
    function (Cpu6502, Video, SoundChip, models, DdNoise, Cmos) {
        "use strict";
        var fakeVideo = new Video.FakeVideo();
        var soundChip = new SoundChip.FakeSoundChip();
        var dbgr = {
            setCpu: function () {
            }
        };

        function fake6502(model, opts) {
            opts = opts || {};
            var video = opts.video || fakeVideo;
            model = model || models.TEST_6502;
            return new Cpu6502(model, dbgr, video, soundChip, new DdNoise.FakeDdNoise(), new Cmos());
        }

        return {
            fake6502: fake6502,
            fake65C12: function () {
                return fake6502(models.TEST_65C12);
            }
        };
    });

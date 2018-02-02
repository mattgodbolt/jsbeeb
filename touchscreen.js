define(['./utils'],
    function (utils) {
        "use strict";

        return function TouchScreen(scheduler) {
            var self = this;
            var PollCycles = 90000; // made up number, seems to be ok
            this.scheduler = scheduler;
            this.lastOutput = [0, 0, 0, 0];
            this.mouse = [];
            this.outBuffer = new utils.Fifo(16);
            this.delay = 0;
            this.mode = 0;
            this.onMouse = function (x, y, button) {
                this.mouse = {x: x, y: y, button: button};
            };
            this.poll = function () {
                self.doRead(true);
                self.pollTask.reschedule(PollCycles);
            };
            this.pollTask = this.scheduler.newTask(this.poll);
            this.onTransmit = function (val) {
                switch (String.fromCharCode(val)) {
                    case 'M':
                        self.mode = 0;
                        break;
                    case '0':
                    case '1':
                    case '2':
                    case '3':
                    case '4':
                    case '5':
                    case '6':
                    case '7':
                    case '8':
                    case '9':
                        self.mode = 10 * self.mode + val - '0'.charCodeAt(0);
                        break;
                    case '.':
                        break;
                    case '?':
                        if (self.mode === 1)
                            self.doRead(false);
                        break;
                }
                self.pollTask.ensureScheduled(self.mode === 129 || self.mode === 130, PollCycles);
            };
            this.tryReceive = function () {
                if (self.outBuffer.size)
                    return self.outBuffer.get();
                return -1;
            };
            this.store = function (byte) {
                self.outBuffer.put(byte);
            };

            function doScale(val, scale, margin) {
                val = (val - margin) / (1 - 2 * margin);
                return val * scale;
            }

            this.doRead = function (ifChanged) {
                var scaleX = 120, marginX = 0.13;
                var scaleY = 100, marginY = 0.03;
                var scaledX = doScale(self.mouse.x, scaleX, marginX);
                var scaledY = doScale(1 - self.mouse.y, scaleY, marginY);
                var toSend = [0x4f, 0x4f, 0x4f, 0x4f];
                var x = Math.min(255, Math.max(0, scaledX)) | 0;
                var y = Math.min(255, Math.max(0, scaledY)) | 0;
                if (self.mouse.button) {
                    toSend[0] = 0x40 | ((x & 0xf0) >>> 4);
                    toSend[1] = 0x40 | (x & 0x0f);
                    toSend[2] = 0x40 | ((y & 0xf0) >>> 4);
                    toSend[3] = 0x40 | (y & 0x0f);
                }
                if (ifChanged &&
                        toSend[0] === self.lastOutput[0] &&
                        toSend[1] === self.lastOutput[1] &&
                        toSend[2] === self.lastOutput[2] &&
                        toSend[3] === self.lastOutput[3]) return;
                self.lastOutput = toSend;
                for (var i = 0; i < 4; ++i)
                    self.store(toSend[i]);
                self.store('.'.charCodeAt(0));
            };
        };
    }
);

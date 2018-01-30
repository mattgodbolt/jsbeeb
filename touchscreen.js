define(['./utils'],
    function (utils) {
        "use strict";

        return function TouchScreen() {
            var self = this;
            this.lastMouse = [];
            this.mouse = [];
            this.outBuffer = new utils.Fifo(16);
            this.delay = 0;
            this.mode = 0;
            this.onMouse = function (x, y, button) {
                this.mouse = {x: x, y: y, button: button};
            };
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
                        if (self.mode == 1)
                            self.doRead(false);
                        break;
                }
            };
            this.tryReceive = function () {
                if (self.mode == 129 || self.mode == 130) self.doRead(true);
                if (self.mode == 129 || self.mode == 130) self.doRead(true);
                if (self.outBuffer.size) {
                    var foo = self.outBuffer.get();
                    return foo;
                }
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
                // if (scaledX > 1 || scaledX < 0 || scaledY > 1 || scaledY < 0) return;
                if (ifChanged &&
                    self.mouse.x === self.lastMouse.x &&
                    self.mouse.y === self.lastMouse.y &&
                    self.mouse.button === self.lastMouse.button) return;
                self.lastMouse = self.mouse;
                // Mostly made up values, tweaked to seem basically right.
                var x = Math.min(255, Math.max(0, scaledX)) | 0;
                var y = Math.min(255, Math.max(0, scaledY)) | 0;
                if (self.mouse.button) {
                    self.store(0x40 | ((x & 0xf0) >>> 4));
                    self.store(0x40 | (x & 0x0f));
                    self.store(0x40 | ((y & 0xf0) >>> 4));
                    self.store(0x40 | (y & 0x0f));
                } else {
                    self.store(0x4f);
                    self.store(0x4f);
                    self.store(0x4f);
                    self.store(0x4f);
                }
                self.store('.'.charCodeAt(0));
            };
        };
    }
);

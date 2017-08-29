define(['./utils'],
    function (utils) {
        "use strict";

        function Fifo(capacity) {
            this.buffer = new Uint8Array(capacity);
            this.size = 0;
            this.wPtr = 0;
            this.rPtr = 0;
        }

        Fifo.prototype.put = function (b) {
            if (this.size == buffer.length) return;
            buffer[this.wPtr % buffer.length] = b;
            this.wPtr++;
            this.size++;
        };

        Fifo.prototype.get = function () {
            if (this.size === 0) return;
            var res = buffer[this.rPtr % buffer.length];
            this.rPtr++;
            this.size--;
            return res;
        };

        return function TouchScreen(mouseFunc) {
            var self = this;
            this.mouseFunc = mouseFunc;
            this.lastMouse = [];
            this.outBuffer = new Uint8Array(16);
            this.delay = 0;
            this.mode = 0
            this.onTransmit = function (val) {
                val = String.fromCharCode(val);
                switch (val) {
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
                        self.mode = 10 * self.mode + val - '0';
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
                if (this.outBuffer.size) return this.outBuffer.get();
                return -1;
            };
            this.store = function (byte) {
                this.outBuffer.put(byte);
            };
            this.doRead = function (ifChanged) {
                var newMouse = this.mouseFunc();
                if (ifChanged && newMouse == this.lastMouse) return;
                this.lastMouse = newMouse;
                if (newMouse.pressed) {

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

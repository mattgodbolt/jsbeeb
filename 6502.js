function hexbyte(value) {
      return ((value >> 4) & 0xf).toString(16) + (value & 0xf).toString(16); 
}

function hexword(value) {
    return hexbyte(value>>8) + hexbyte(value & 0xff);
}


function cpu6502() {
    this.ramBank = new Uint8Array(16);
    this.memstat = [new Uint8Array(256), new Uint8Array(256)];
    this.memlook = [new Uint32Array(256), new Uint32Array(256)];
    this.ramRomOs = new Uint8Array(128 * 1024 + 2 * 16 * 16384);
    this.vis20k = 0;
    this.romOffset = 128 * 1024;
    this.osOffset = this.romOffset + 16 * 1024;

    this.readmem = function(addr) {
        if (this.debugRead) this.debugRead(addr);
        var offset = this.memlook[this.vis20k][addr >> 8];
        if (offset !== 0xffffffff) {
            console.log(offset);
            return this.ramRomOs[offset + addr];
        }
        return null;
    }

    this.loadOs = function(name) {
        console.log("Loading OS from " + name);
        var request = new XMLHttpRequest();
        request.open("GET", name, false);
        request.overrideMimeType('text/plain; charset=x-user-defined');
        request.send(null);
        if (request.response.length != 16384) {
            throw "Broken rom file";
        }
        for (var i = 0; i < 16384; ++i) {
            this.ramRomOs[this.osOffset + i] = request.response.charCodeAt(i) & 0xff;
        }
    }

    this.reset = function() {
        console.log("Resetting 6502");
        var i;
        for (i = 0; i < 16; ++i) this.ramBank[i] = 0;
        for (i = 0; i < 128; ++i) this.memstat[0][i] = this.memstat[1][i] = 1;
        for (i = 128; i < 256; ++i) this.memstat[0][i] = this.memstat[1][i] = 2;
        for (i = 0; i < 128; ++i) this.memlook[0][i] = this.memlook[1][i] = 0;
        /* TODO: Model A support here */
        for (i = 48; i < 128; ++i) this.memlook[1][i] = 16384;
        for (i = 128; i < 192; ++i) this.memlook[0][i] = this.memlook[1][i] = this.romOffset - 0x8000;
        for (i = 192; i < 256; ++i) this.memlook[0][i] = this.memlook[1][i] = this.osOffset - 0xc000;

        for (i = 0xfc; i < 0xff; ++i) this.memstat[0][i] = this.memstat[1][i] = 0;

        this.cycles = 0;
        this.ram4k = this.ram8k = this.ram12k = this.ram20k = 0;
        this.pc = this.readmem(0xfffc) | (this.readmem(0xfffd)<<8);
        console.log("Starting PC = " + hexword(this.pc));
        this.p = {i: 1};
        this.nmi = this.oldnmi = this.nmilock = 0;
        this.output = 0;
        this.tubecycle = this.tubecycles = 0;
    };

    this.loadOs("roms/os");
    this.reset();
}


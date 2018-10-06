define([], function () {
    "use strict";

    var Table4BppSize = 256 * 16 * 4;
    var UlaPalSize = 16;

    function getConfig(offset) {
        function alloc(size) {
            var res = offset;
            offset += size;
            return res;
        }

        var table4bppAddress = alloc(Table4BppSize);
        var ulaAddress = alloc(UlaPalSize * 4);
        return {
            table4bppAddress: table4bppAddress,
            ulaAddress: ulaAddress,
            endOffset: offset
        };
    }

    function initTable4Bpp(mem8, offsetFunc) {
        var i, b, temp, left;
        for (b = 0; b < 256; ++b) {
            temp = b;
            for (i = 0; i < 16; ++i) {
                left = 0;
                if (temp & 2) left |= 1;
                if (temp & 8) left |= 2;
                if (temp & 32) left |= 4;
                if (temp & 128) left |= 8;
                mem8[offsetFunc(3, b) + i] = left;
                temp <<= 1;
                temp |= 1;
            }
            for (i = 0; i < 16; ++i) {
                mem8[offsetFunc(2, b) + i] = mem8[offsetFunc(3, b) + (i >>> 1)];
                mem8[offsetFunc(1, b) + i] = mem8[offsetFunc(3, b) + (i >>> 2)];
                mem8[offsetFunc(0, b) + i] = mem8[offsetFunc(3, b) + (i >>> 3)];
            }
        }
    }

    function create(offset, buffer) {
        // Make a node.js compatible stdlib
        var stdlib = {
            Uint8Array: Uint8Array,
            Uint32Array: Uint32Array
        };
        var config = getConfig(offset);
        var asm = new BlitterAsm(stdlib, config, buffer);
        var ulaPal = new Uint32Array(buffer, config.ulaAddress, UlaPalSize);

        initTable4Bpp(new Uint8Array(buffer), asm.table4bppOffset);

        return {
            clearFb: asm.clearFb,
            ulaPalOffset: asm.ulaPalOffset,
            blitFb: asm.blitFb,
            ulaPal: ulaPal
        };
    }

    function BlitterAsm(stdlib, foreign, buffer) {
        "use asm";

        var mem8 = new stdlib.Uint8Array(buffer);
        var mem32 = new stdlib.Uint32Array(buffer);

        var ulaAddress = foreign.ulaAddress | 0;
        var table4bppAddress = foreign.table4bppAddress | 0;

        function clearFb(destOffset, numPixels) {
            destOffset = destOffset | 0;
            numPixels = numPixels | 0;

            var i = 0;

            destOffset = destOffset << 2;

            for (i = 0; (i | 0) < (numPixels | 0); i = (i + 1) | 0) {
                mem32[destOffset >> 2] = 0xff000000;
                destOffset = (destOffset + 4) | 0;
            }
        }

        function table4bppOffset(ulamode, byte) {
            ulamode = ulamode | 0;
            byte = byte | 0;
            return (table4bppAddress + (ulamode << 12) | (byte << 4)) | 0;
        }

        function ulaPalOffset() {
            return ulaAddress | 0;
        }

        function blitFb(ulaMode, dat, destOffset, numPixels, doubledY) {
            ulaMode = ulaMode | 0;
            dat = dat | 0;
            destOffset = destOffset | 0;
            numPixels = numPixels | 0;
            doubledY = doubledY | 0;
            var i = 0;
            var offset = 0;
            var temp = 0;
            offset = table4bppOffset(ulaMode, dat) | 0;
            for (i = 0; (i | 0) < (numPixels | 0); i = (i + 1) | 0) {
                temp = mem8[((offset | 0) + (i | 0)) | 0] | 0; // table4bpp[offset + i];
                temp = mem32[((temp << 2) + ulaAddress) >> 2] | 0; // ulaPal[temp]
                mem32[((destOffset + i) << 2) >> 2] = temp | 0;
                if (doubledY) {
                    mem32[((destOffset + i + 1024) << 2) >> 2] = temp | 0;
                }
            }
        }

        return {
            clearFb: clearFb,
            table4bppOffset: table4bppOffset,
            ulaPalOffset: ulaPalOffset,
            blitFb: blitFb
        };
    }

    return {
        scratchSpaceRequired: getConfig(0).endOffset,
        create: create
    };
});
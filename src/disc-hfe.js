// HFE format implementation for disc image loading and saving
// Translated from beebjit by Chris Evans and expanded by Matt Godbolt.

import { IbmDiscFormat } from "./disc.js";

// HFE format constants
const HfeHeaderV1 = "HXCPICFE";
const HfeHeaderV3 = "HXCHFEV3";
const HfeV3OpcodeMask = 0xf0;
const HfeV3OpcodeNop = 0xf0;
const HfeV3OpcodeSetIndex = 0xf1;
const HfeV3OpcodeSetBitrate = 0xf2;
const HfeV3OpcodeSkipBits = 0xf3;
const HfeV3OpcodeRand = 0xf4;
const HfeBlockSideSize = 256;
const HfeBlockSize = HfeBlockSideSize * 2;
const HfeShugartDdFloppyMode = 7;
const HfeIsoIbmFmEncoding = 2;

// 250kbit bitrate value per HFE format specification
const Bitrate250k = 72;

/**
 * Flip the bits in a byte for HFE encoding
 * @param {number} val - Byte value to flip
 * @returns {number} - Flipped byte value
 */
function hfeByteFlip(val) {
    let ret = 0;
    if (val & 0x80) ret |= 0x01;
    if (val & 0x40) ret |= 0x02;
    if (val & 0x20) ret |= 0x04;
    if (val & 0x10) ret |= 0x08;
    if (val & 0x08) ret |= 0x10;
    if (val & 0x04) ret |= 0x20;
    if (val & 0x02) ret |= 0x40;
    if (val & 0x01) ret |= 0x80;

    return ret;
}

/**
 * Get the track offset and length from HFE metadata
 * @param {Uint8Array} metadata - HFE lookup table metadata
 * @param {number} track - Track number
 * @returns {{offset: number, length: number}} - Track offset and length
 */
function hfeGetTrackOffsetAndLength(metadata, track) {
    const index = track << 2;
    const offset = HfeBlockSize * (metadata[index] + (metadata[index + 1] << 8));
    const length = metadata[index + 2] + (metadata[index + 3] << 8);
    return { offset, length };
}

/**
 * Load a disc image in HFE format (v1 or v3)
 * @param {import("./disc.js").Disc} disc - The disc object to load into
 * @param {Uint8Array} data - The HFE file data
 * @param {function(Uint8Array): void} onChange - Optional callback when disc content changes
 * @returns {import("./disc.js").Disc} - The loaded disc object
 */
export function loadHfe(disc, data, onChange) {
    if (data.length < HfeBlockSize) throw new Error("HFE file missing header");
    const header = new TextDecoder("ascii").decode(data.slice(0, 8));
    let isV3 = false;
    let hfeVersion = 1;

    if (header === HfeHeaderV1) {
        // HFE v1 format
    } else if (header === HfeHeaderV3) {
        hfeVersion = 3;
        isV3 = true;
    } else {
        throw new Error(`HFE file bad header '${header}'`);
    }
    if (data[8] !== 0) throw new Error("HFE file revision not 0");
    if (data[11] !== 2 && data[11] !== 0) {
        if (data[11] === 0xff) {
            console.log(`Unknown HFE encoding ${data[11]}, trying anyway`);
        } else {
            throw new Error(`HFE encoding not ISOIBM_(M)FM_ENCODING: ${data[11]}`);
        }
    }
    const numSides = data[10];
    if (numSides < 1 || numSides > 2) throw new Error(`Invalid number of sides: ${numSides}`);

    const numTracks = data[9];
    if (numTracks > IbmDiscFormat.tracksPerDisc) throw new Error(`Too many tracks: ${numTracks}`);
    let expandShift = 0;
    if (disc.config.expandTo80 && numTracks * 2 <= IbmDiscFormat.tracksPerDisc) {
        expandShift = 1;
        console.log("Expanding 40 tracks to 80");
    }

    console.log(`HFE v${hfeVersion} loading ${numSides} sides, ${numTracks} tracks`);

    const lutOffset = HfeBlockSize * (data[18] + (data[19] << 8));
    if (lutOffset + HfeBlockSize > data.length) throw new Error("HFE LUT doesn't fit");

    const metadata = data.slice(lutOffset, lutOffset + HfeBlockSize);

    for (let trackNum = 0; trackNum < numTracks; ++trackNum) {
        let actualTrackNum = trackNum;
        if (disc.config.isSkipOddTracks) {
            if (trackNum & 1) continue;
            actualTrackNum = trackNum >>> 1;
        }
        actualTrackNum = actualTrackNum << expandShift;
        const { offset, length } = hfeGetTrackOffsetAndLength(metadata, trackNum);
        if (offset + length > data.length)
            throw new Error(
                `HFE track ${trackNum} doesn't fit (length ${length} offset ${offset} file length ${data.length})`,
            );
        const trackData = data.slice(offset, offset + length);

        for (let sideNum = 0; sideNum < numSides; ++sideNum) {
            const bufLen = length >> 1;
            let bytesWritten = 0;
            if (disc.config.isSkipUpperSide && sideNum === 1) continue;

            let isSetBitRate = false;
            let isSkipBits = false;
            let skipBitsLength = 0;
            let pulses = 0;
            let shiftCounter = 0;

            const trackObj = disc.getTrack(sideNum === 1, actualTrackNum);
            disc.setTrackUsed(sideNum === 1, actualTrackNum);
            const rawPulses = trackObj.pulses2Us;
            for (let byteIndex = 0; byteIndex < bufLen; ++byteIndex) {
                if (bytesWritten === rawPulses.length) {
                    throw new Error(`HFE track ${trackNum} truncated`);
                }
                const index = ((byteIndex >>> 8) << 9) + (sideNum << 8) + (byteIndex & 0xff);
                let byte = hfeByteFlip(trackData[index]);
                let numBits = 8;

                if (isSetBitRate) {
                    isSetBitRate = false;
                    if (byte < 64 || byte > 80) {
                        console.log(`HFE v3 SETBITRATE wild (72=250kbit) track: ${trackNum} ${byte}`);
                    }
                    continue;
                } else if (isSkipBits) {
                    isSkipBits = false;
                    if (byte === 0 || byte >= 8) {
                        throw new Error(`HFE v3 invalid skipbits ${byte}`);
                    }
                    skipBitsLength = byte;
                    continue;
                } else if (skipBitsLength) {
                    byte = (byte << (8 - skipBitsLength)) & 0xff;
                    numBits = skipBitsLength;
                    skipBitsLength = 0;
                } else if (isV3 && (byte & HfeV3OpcodeMask) === HfeV3OpcodeMask) {
                    switch (byte) {
                        case HfeV3OpcodeNop:
                            continue; // NB continue
                        case HfeV3OpcodeSetIndex:
                            if (bytesWritten !== 0)
                                console.log(`HFEv3 SETINDEX not at byte 0, track ${trackNum}: ${bytesWritten}`);
                            continue; // NB continue
                        case HfeV3OpcodeSetBitrate:
                            isSetBitRate = true;
                            continue; // NB continue
                        case HfeV3OpcodeSkipBits:
                            isSkipBits = true;
                            continue; // NB continue
                        case HfeV3OpcodeRand:
                            // internally we represent weak bits on disc as a no flux area.
                            byte = 0;
                            break; // NB a break
                        default:
                            throw new Error(`Unknown HFE v3 opcode ${byte}`);
                    }
                }

                for (let bitIndex = 0; bitIndex < numBits; ++bitIndex) {
                    pulses = ((pulses << 1) & 0xffffffff) | (byte & 0x80 ? 1 : 0);
                    byte = (byte << 1) & 0xff;
                    if (++shiftCounter === 32) {
                        rawPulses[bytesWritten] = pulses;
                        bytesWritten++;
                        pulses = 0;
                        shiftCounter = 0;
                    }
                }
            }
            trackObj.length = bytesWritten;
        }
    }

    // Set up write track callback if onChange is provided
    if (onChange) {
        disc.setWriteTrackCallback((_side, _trackNum, _trackObj) => {
            // Generate a complete HFE image from the current disc state
            const hfeData = toHfe(disc);
            // Call the onChange handler with the updated HFE data
            onChange(hfeData);
        });
    }

    return disc;
}

/**
 * Check if a byte could be mistakenly interpreted as a v3 opcode
 * @param {number} byte - The byte to check after bit flipping
 * @returns {boolean} - True if the byte could be interpreted as a v3 opcode
 */
function isHfeV3OpcodeCollision(byte) {
    // After bit flipping, check if the lower 4 bits are all 1s (0x0F)
    return (byte & 0x0f) === 0x0f;
}

/**
 * Encode a single 32-bit pulse value to 4 bytes in HFE v3 format
 * Handles opcode collisions by replacing with RAND opcode if needed
 * @param {number} pulsesWord - The 32-bit pulse value
 * @returns {Uint8Array} - 4 bytes of HFE v3 encoded data
 */
function encodeHfeV3Pulses(pulsesWord) {
    const result = new Uint8Array(4);

    for (let i = 0; i < 4; i++) {
        const byte = (pulsesWord >>> 24) & 0xff;
        const flippedByte = hfeByteFlip(byte);

        // Check if the byte could be mistakenly interpreted as a v3 opcode
        if (isHfeV3OpcodeCollision(flippedByte)) {
            // Replace with bit-flipped RAND opcode
            result[i] = hfeByteFlip(HfeV3OpcodeRand);
        } else {
            result[i] = flippedByte;
        }

        pulsesWord <<= 8;
    }

    return result;
}

/**
 * Convert track data to HFE v3 format, handling weak pulses and opcode collisions
 * @param {Uint32Array|Array<number>} pulses - Array of 32-bit pulse values for the track
 * @returns {Uint8Array} - The track data in HFE v3 format
 */
export function convertTrackToHfeV3(pulses) {
    // Calculate the max potential size (4 bytes per pulse value + 3 bytes header)
    const buffer = new Uint8Array(pulses.length * 4 + 3);
    let bufferIndex = 0;

    // Add HFE v3 header opcodes (SETINDEX, SETBITRATE, Bitrate250k)
    buffer[bufferIndex++] = hfeByteFlip(HfeV3OpcodeSetIndex);
    buffer[bufferIndex++] = hfeByteFlip(HfeV3OpcodeSetBitrate);
    buffer[bufferIndex++] = hfeByteFlip(Bitrate250k);

    // Process each pulse
    for (let i = 0; i < pulses.length; i++) {
        const pulse = pulses[i];

        if (pulse === 0) {
            // Handle weak bits explicitly in HFEv3 with RAND opcode
            const randOpcode = hfeByteFlip(HfeV3OpcodeRand);
            buffer.fill(randOpcode, bufferIndex, bufferIndex + 4);
        } else {
            // Encode normal pulses, handling potential opcode collisions
            const encodedPulses = encodeHfeV3Pulses(pulse);
            buffer.set(encodedPulses, bufferIndex);
        }

        bufferIndex += 4;
    }

    // Return only the used part of the buffer
    return buffer.slice(0, bufferIndex);
}

/**
 * Convert disc to HFE v3 format
 * HFE is a format used by the HxC Floppy Emulator for storing disk images.
 * This implementation supports variable track lengths without truncation.
 * Reference: https://hxc2001.com/download/floppy_drive_emulator/SDCard_HxC_Floppy_Emulator_HFE_file_format.pdf
 * @param {import("./disc.js").Disc} disc - The disc to convert to HFE
 * @returns {Uint8Array} - The HFE file data
 */
export function toHfe(disc) {
    const numSides = disc.isDoubleSided ? 2 : 1;
    const numTracks = disc.tracksUsed;

    // Pre-calculate sizes for each track to properly support variable track lengths
    const trackSizes = [];
    const trackOffsetDeltas = [];
    for (let trackNum = 0; trackNum < numTracks; trackNum++) {
        const track0 = disc.getTrack(false, trackNum);
        const track1 = numSides > 1 ? disc.getTrack(true, trackNum) : { length: 0 };

        // Calculate the actual size needed for this specific track
        // From C code: 4 bytes per 32-bit word, 3 "header" HFEv3 bytes, 2 sides
        const trackLen = Math.max(track0.length, track1.length);
        const hfeTrackLen = (trackLen * 4 + 3) * 2;
        const hfeOffsetDelta = Math.floor(hfeTrackLen / HfeBlockSize) + 1;

        trackSizes.push(hfeTrackLen);
        trackOffsetDeltas.push(hfeOffsetDelta);
    }

    // Build header
    const header = new Uint8Array(512);
    header.fill(0xff);

    // Write HFE v3 signature
    const encoder = new TextEncoder();
    header.set(encoder.encode("HXCHFEV3"), 0);
    header[8] = 0; // Revision 0
    header[9] = numTracks;
    header[10] = numSides;
    header[11] = HfeIsoIbmFmEncoding; // IBM FM/MFM encoding
    header[12] = 250; // Bit rate (nb we use the set bitrate command per track)
    header[13] = 0;
    header[14] = 0; // RPM (unused)
    header[15] = 0;
    header[16] = HfeShugartDdFloppyMode; // Mode: Shugart DD
    header[17] = 0xff; // Unused
    header[18] = 1; // LUT offset at block 1 (512 bytes)
    header[19] = 0;
    header[20] = 0xff; // Write allowed
    header[21] = 0xff; // Single step
    header[22] = 0xff; // No alternate track options
    header[23] = 0xff;
    header[24] = 0xff;
    header[25] = 0xff;

    const headerSize = HfeBlockSize;
    // Assume everything will fit into one block.
    const lutSize = 1 * HfeBlockSize;

    // Build LUT (Lookup Table) for track offsets
    const lut = new Uint8Array(lutSize);
    const lutDataView = new DataView(lut.buffer);
    let hfeOffset = 2; // Start at block 2 (after header and LUT)

    // Calculate total file size and build LUT
    let totalSize = headerSize + lutSize;

    for (let trackNum = 0; trackNum < numTracks; trackNum++) {
        const byteOffset = trackNum * 4;
        lutDataView.setUint16(byteOffset, hfeOffset, true); // Offset in 512-byte blocks
        lutDataView.setUint16(byteOffset + 2, trackSizes[trackNum], true); // Track-specific length in bytes

        // Add this track's size to the total and advance offset
        totalSize += trackOffsetDeltas[trackNum] * HfeBlockSize;
        hfeOffset += trackOffsetDeltas[trackNum];
    }
    const hfeData = new Uint8Array(totalSize);

    // Write header
    hfeData.set(header, 0);
    // Write LUT
    hfeData.set(lut, headerSize);

    // Write track data
    let trackOffset = 1024; // Start after header and LUT
    for (let trackNum = 0; trackNum < numTracks; trackNum++) {
        // Process each side separately
        for (let side = 0; side < numSides; side++) {
            const track = disc.getTrack(side === 1, trackNum);
            const pulses = track.pulses2Us;

            const trackBuffer = convertTrackToHfeV3(pulses.slice(0, track.length));
            let bufferIndex = trackBuffer.length;

            // Write track data in per-side sized chunks, interleaved according to HFE format
            let writePos = trackOffset + (side === 1 ? HfeBlockSideSize : 0);
            let iByte = 0;

            while (iByte < bufferIndex) {
                const chunkLen = Math.min(HfeBlockSideSize, bufferIndex - iByte);
                const chunk = new Uint8Array(HfeBlockSideSize);

                if (chunkLen > 0) {
                    chunk.set(trackBuffer.slice(iByte, iByte + chunkLen));
                }

                hfeData.set(chunk, writePos);
                writePos += HfeBlockSize;
                iByte += chunkLen;
            }
        }

        // Move to the next track after processing all sides
        trackOffset += trackOffsetDeltas[trackNum] * HfeBlockSize;
    }

    return hfeData;
}

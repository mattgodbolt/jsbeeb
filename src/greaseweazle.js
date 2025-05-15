/**
 * GreaseWeazle JavaScript Implementation
 *
 * This module provides a JavaScript interface to the GreaseWeazle floppy disk controller.
 * It uses a pluggable transport architecture to support WebSerial, WebUSB, or mock transports.
 */

import { Track, TrackBuilder, IbmDiscFormat } from "./disc.js";

// Command codes
const Cmd = {
    GetInfo: 0,
    Update: 1,
    Seek: 2,
    Head: 3,
    SetParams: 4,
    GetParams: 5,
    Motor: 6,
    ReadFlux: 7,
    WriteFlux: 8,
    GetFluxStatus: 9,
    GetIndexTimes: 10,
    SwitchFwMode: 11,
    Select: 12,
    Deselect: 13,
    SetBusType: 14,
    SetPin: 15,
    Reset: 16,
    EraseFlux: 17,
    SourceBytes: 18,
    SinkBytes: 19,
    GetPin: 20,
    TestMode: 21,
    NoClickStep: 22,
};

// Response/acknowledgement codes
const Ack = {
    Okay: 0,
    BadCommand: 1,
    NoIndex: 2,
    NoTrk0: 3,
    FluxOverflow: 4,
    FluxUnderflow: 5,
    Wrprot: 6,
    NoUnit: 7,
    NoBus: 8,
    BadUnit: 9,
    BadPin: 10,
    BadCylinder: 11,
    OutOfSRAM: 12,
    OutOfFlash: 13,
};

// Control-path command set (baud rates)
const ControlCmd = {
    ClearComms: 10000,
    Normal: 9600,
};

// GetInfo indexes
const GetInfo = {
    Firmware: 0,
    BandwidthStats: 1,
    CurrentDrive: 7,
};

// Bus types
const BusType = {
    Invalid: 0,
    IBMPC: 1,
    Shugart: 2,
};

// Flux stream opcodes
const FluxOp = {
    Index: 1,
    Space: 2,
    Astable: 3,
};

/**
 * Abstract transport interface
 */
class Transport {
    async open() {
        throw new Error("Transport.open() must be implemented");
    }

    async close() {
        throw new Error("Transport.close() must be implemented");
    }

    async write(_data) {
        throw new Error("Transport.write() must be implemented");
    }

    async read(_length) {
        throw new Error("Transport.read() must be implemented");
    }

    async changeBaudRate(_baudRate) {
        throw new Error("Transport.changeBaudRate() must be implemented");
    }

    async readAvailable(_maxBytes) {
        throw new Error("Transport.readAvailable() must be implemented");
    }
}

/**
 * WebSerial transport implementation
 */
class WebSerialTransport extends Transport {
    constructor(port = null) {
        super();
        this.port = port;
        this.reader = null;
        this.writer = null;
        this.portOpen = false;
        this.buffer = new Uint8Array(0);
    }

    async requestPort(filters = {}) {
        if (!this.port) {
            this.port = await navigator.serial.requestPort(filters);
        }
        return this.port;
    }

    async open(baudRate = 9600) {
        if (!this.port) {
            throw new Error("No port selected. Call requestPort() first.");
        }

        await this.port.open({
            baudRate: baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            bufferSize: 4096,
        });

        this.writer = this.port.writable.getWriter();
        this.reader = this.port.readable.getReader();
        this.portOpen = true;
    }

    async close() {
        if (this.reader) {
            this.reader.releaseLock();
            this.reader = null;
        }
        if (this.writer) {
            this.writer.releaseLock();
            this.writer = null;
        }
        if (this.port && this.portOpen) {
            await this.port.close();
            this.portOpen = false;
        }
        this.buffer = new Uint8Array(0);
    }

    async write(data) {
        if (!this.writer) {
            throw new Error("Port not open");
        }
        await this.writer.write(data);
    }

    _consumeBuffer(result, length) {
        const bytesToConsume = Math.min(length, this.buffer.length);
        result.set(this.buffer.subarray(0, bytesToConsume), 0);
        this.buffer = this.buffer.subarray(bytesToConsume);
        return bytesToConsume;
    }

    _appendToBuffer(data) {
        const newBuffer = new Uint8Array(this.buffer.length + data.length);
        newBuffer.set(this.buffer, 0);
        newBuffer.set(data, this.buffer.length);
        this.buffer = newBuffer;
    }

    async read(length) {
        if (!this.reader) {
            throw new Error("Port not open");
        }

        const result = new Uint8Array(length);
        let offset = this._consumeBuffer(result, length);

        if (offset >= length) {
            return result;
        }

        while (offset < length) {
            const { value, done } = await this.reader.read();
            if (done) {
                throw new Error("Stream closed while reading");
            }

            const remaining = length - offset;
            const toCopy = Math.min(remaining, value.length);
            result.set(value.subarray(0, toCopy), offset);
            offset += toCopy;

            if (value.length > toCopy) {
                this._appendToBuffer(value.subarray(toCopy));
            }
        }

        return result;
    }

    async changeBaudRate(baudRate) {
        await this.close();
        await this.open(baudRate);
    }

    async readAvailable(maxBytes) {
        if (!this.reader) {
            throw new Error("Port not open");
        }

        // First check if we have buffered data
        if (this.buffer.length > 0) {
            const bytesToReturn = Math.min(maxBytes, this.buffer.length);
            const result = this.buffer.subarray(0, bytesToReturn);
            this.buffer = this.buffer.subarray(bytesToReturn);
            return result;
        }

        // No buffered data, do a single read from the port
        const { value, done } = await this.reader.read();
        if (done) {
            throw new Error("Stream closed while reading");
        }

        // Return up to maxBytes
        const bytesToReturn = Math.min(maxBytes, value.length);
        const result = value.subarray(0, bytesToReturn);

        // Buffer any excess
        if (value.length > bytesToReturn) {
            this._appendToBuffer(value.subarray(bytesToReturn));
        }

        return result;
    }
}

/**
 * Command error class
 */
class CmdError extends Error {
    constructor(cmd, code) {
        const ackStr = Object.keys(Ack).find((key) => Ack[key] === code) || `Unknown Error (${code})`;
        const cmdStr = Object.keys(Cmd).find((key) => Cmd[key] === cmd[0]) || "UnknownCmd";
        super(`${cmdStr}: ${ackStr}`);
        this.cmd = cmd;
        this.code = code;
    }
}

/**
 * Main GreaseWeazle class
 */
class GreaseWeazle {
    constructor(transport, logger = console.log) {
        this.transport = transport;
        this.log = logger;
        this.firmwareInfo = null;
        this.isConnected = false;
    }

    /**
     * Connect to the device and initialize
     */
    async connect() {
        this.log("Connecting to GreaseWeazle...");

        // Reset communication
        await this.reset();

        // Get firmware info
        await this.getFirmwareInfo();

        this.isConnected = true;
        this.log("Connected to GreaseWeazle");
    }

    /**
     * Disconnect from the device
     */
    async disconnect() {
        this.log("Disconnecting from GreaseWeazle...");
        await this.transport.close();
        this.isConnected = false;
        this.log("Disconnected");
    }

    /**
     * Reset communication with the device
     */
    async reset() {
        this.log("Resetting communication...");

        // Clear output buffer
        await this.transport.close();

        // Set to ClearComms baud rate
        await this.transport.open(ControlCmd.ClearComms);

        // Return to normal baud rate
        await this.transport.changeBaudRate(ControlCmd.Normal);

        this.log("Communication reset complete");
    }

    /**
     * Send a command and get response
     */
    async sendCommand(cmd) {
        this.log(`Sending command: ${this.formatCommand(cmd)}`);

        // Send command
        await this.transport.write(cmd);

        // Read response (command echo + result code)
        const response = await this.transport.read(2);
        const [cmdEcho, resultCode] = response;

        // Check command echo
        if (cmdEcho !== cmd[0]) {
            throw new Error(`Command echo mismatch: expected ${cmd[0]}, got ${cmdEcho}`);
        }

        // Check result code
        if (resultCode !== Ack.Okay) {
            throw new CmdError(cmd, resultCode);
        }

        this.log(`Command successful: ${this.formatCommand(cmd)}`);
        return response;
    }

    /**
     * Format command for logging
     */
    formatCommand(cmd) {
        const cmdName = Object.keys(Cmd).find((key) => Cmd[key] === cmd[0]) ?? "Unknown";
        return `${cmdName} (0x${cmd[0].toString(16).padStart(2, "0")})`;
    }

    /**
     * Get firmware information
     */
    async getFirmwareInfo() {
        this.log("Getting firmware info...");

        const cmd = new Uint8Array([Cmd.GetInfo, 3, GetInfo.Firmware]);
        await this.sendCommand(cmd);

        // Read firmware info structure (32 bytes)
        const info = await this.transport.read(32);

        this.firmwareInfo = {
            majorVersion: info[0],
            minorVersion: info[1],
            isMainFirmware: info[2],
            maxCmd: info[3],
            sampleFreq: info[4] | (info[5] << 8) | (info[6] << 16) | (info[7] << 24),
            hwModel: info[8],
            hwSubmodel: info[9],
            usbSpeed: info[10],
            mcuId: info[11],
            mcuMhz: info[12] | (info[13] << 8),
            mcuSramKb: info[14] | (info[15] << 8),
            usbBufKb: info[16] | (info[17] << 8),
        };

        this.log(`Firmware version: ${this.firmwareInfo.majorVersion}.${this.firmwareInfo.minorVersion}`);
        this.log(`Sample frequency: ${this.firmwareInfo.sampleFreq} Hz`);

        return this.firmwareInfo;
    }

    /**
     * Select a drive unit
     */
    async selectDrive(unit) {
        this.log(`Selecting drive unit ${unit}...`);
        const cmd = new Uint8Array([Cmd.Select, 3, unit]);
        await this.sendCommand(cmd);
        this.log(`Drive unit ${unit} selected`);
    }

    /**
     * Deselect the current drive
     */
    async deselectDrive() {
        this.log("Deselecting drive...");
        const cmd = new Uint8Array([Cmd.Deselect, 2]);
        await this.sendCommand(cmd);
        this.log("Drive deselected");
    }

    /**
     * Set the bus type
     */
    async setBusType(type) {
        this.log(`Setting bus type to ${type}...`);
        const cmd = new Uint8Array([Cmd.SetBusType, 3, type]);
        await this.sendCommand(cmd);
        this.log(`Bus type set to ${type}`);
    }

    /**
     * Control drive motor
     */
    async setMotor(unit, state) {
        this.log(`Setting motor ${state ? "ON" : "OFF"} for unit ${unit}...`);
        const cmd = new Uint8Array([Cmd.Motor, 4, unit, state ? 1 : 0]);
        await this.sendCommand(cmd);
        this.log(`Motor ${state ? "ON" : "OFF"} for unit ${unit}`);
    }

    /**
     * Seek to cylinder and select head
     */
    async seek(cylinder, head) {
        this.log(`Seeking to cylinder ${cylinder}, head ${head}...`);

        // Seek to cylinder
        let seekCmd;
        if (cylinder >= -128 && cylinder <= 127) {
            seekCmd = new Uint8Array([Cmd.Seek, 3, cylinder & 0xff]);
        } else if (cylinder >= -32768 && cylinder <= 32767) {
            const cylBytes = new Uint8Array(2);
            new DataView(cylBytes.buffer).setInt16(0, cylinder, true);
            seekCmd = new Uint8Array([Cmd.Seek, 4, ...cylBytes]);
        } else {
            throw new Error(`Invalid cylinder: ${cylinder}`);
        }

        await this.sendCommand(seekCmd);

        // Select head
        const headCmd = new Uint8Array([Cmd.Head, 3, head]);
        await this.sendCommand(headCmd);

        this.log(`Positioned at cylinder ${cylinder}, head ${head}`);
    }

    /**
     * Read flux data from current track
     */
    async readFlux(revolutions = 3, ticks = 0, retries = 5) {
        this.log(`Reading flux data (revs=${revolutions}, ticks=${ticks})...`);

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                // Send ReadFlux command
                const cmd = new Uint8Array(8);
                const view = new DataView(cmd.buffer);
                cmd[0] = Cmd.ReadFlux;
                cmd[1] = 8;
                view.setUint32(2, ticks, true);
                view.setUint16(6, revolutions === 0 ? 0 : revolutions + 1, true);

                await this.sendCommand(cmd);

                // Read flux data stream until terminating 0 byte
                const fluxData = await this.readFluxStream();

                // Check flux status - this raises exception on error
                await this.getFluxStatus();

                // Decode flux data
                const decoded = this.decodeFlux(fluxData);
                this.log(`Read ${decoded.fluxList.length} flux transitions`);

                return decoded;
            } catch (error) {
                // Only retry on flux overflow, and only if we have attempts left
                const shouldRetry = error instanceof CmdError && error.code === Ack.FluxOverflow && attempt < retries;

                if (shouldRetry) {
                    this.log(`Flux overflow, retry ${attempt + 1}/${retries}`);
                    continue;
                }

                throw error;
            }
        }
    }

    /**
     * Read flux data stream until we find the terminating 0 byte
     */
    async readFluxStream() {
        const chunks = [];
        const chunkSize = 512;
        const maxSize = 1024 * 1024; // 1MB safety limit

        while (true) {
            const chunk = await this.transport.readAvailable(chunkSize);

            // Look for terminator
            const endIndex = chunk.indexOf(0);
            if (endIndex !== -1) {
                // Found terminator - keep data up to and including it
                chunks.push(chunk.subarray(0, endIndex + 1));
                break;
            }

            chunks.push(chunk);

            // Safety check
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            if (totalLength > maxSize) {
                throw new Error(`Flux stream too large (>${maxSize} bytes)`);
            }
        }

        // Combine chunks efficiently
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        this.log(`Read flux stream of ${totalLength} bytes`);
        return result;
    }

    /**
     * Get flux operation status
     */
    async getFluxStatus() {
        const cmd = new Uint8Array([Cmd.GetFluxStatus, 2]);
        await this.sendCommand(cmd);
    }

    /**
     * Decode flux data stream
     */
    decodeFlux(data) {
        const fluxList = [];
        const indexList = [];
        let ticks = 0;
        let ticksSinceIndex = 0;
        let i = 0;

        // Helper to read 28-bit value
        const read28bit = () => {
            const val =
                ((data[i++] & 0xfe) >> 1) |
                ((data[i++] & 0xfe) << 6) |
                ((data[i++] & 0xfe) << 13) |
                ((data[i++] & 0xfe) << 20);
            return val;
        };

        // Process flux data (skip last byte which is 0)
        while (i < data.length - 1) {
            const byte = data[i++];

            if (byte === 0xff) {
                // Special opcode
                const opcode = data[i++];

                if (opcode === FluxOp.Index) {
                    const val = read28bit();
                    indexList.push(ticksSinceIndex + ticks + val);
                    ticksSinceIndex = -(ticks + val);
                } else if (opcode === FluxOp.Space) {
                    ticks += read28bit();
                } else {
                    throw new Error(`Bad opcode in flux stream: ${opcode}`);
                }
            } else {
                // Regular flux value
                let val;
                if (byte < 250) {
                    val = byte;
                } else {
                    val = 250 + (byte - 250) * 255;
                    val += data[i++] - 1;
                }

                ticks += val;
                fluxList.push(ticks);
                ticksSinceIndex += ticks;
                ticks = 0;
            }
        }

        return { fluxList, indexList };
    }

    /**
     * Write flux data to current track
     */
    async writeFlux(fluxList, cueAtIndex = true, terminateAtIndex = true, retries = 5) {
        this.log(`Writing flux data (${fluxList.length} transitions)...`);

        // Encode flux data
        const encodedData = this.encodeFlux(fluxList);

        let retry = 0;
        while (retry <= retries) {
            try {
                // Send WriteFlux command
                const cmd = new Uint8Array([Cmd.WriteFlux, 4, cueAtIndex ? 1 : 0, terminateAtIndex ? 1 : 0]);
                await this.sendCommand(cmd);

                // Write flux data
                await this.transport.write(encodedData);

                // Sync
                await this.transport.read(1);

                // Get flux status
                await this.getFluxStatus();

                this.log(`Successfully wrote ${fluxList.length} flux transitions`);
                return;
            } catch (error) {
                if (error instanceof CmdError && error.code === Ack.FluxUnderflow && retry < retries) {
                    retry++;
                    this.log(`Flux underflow, retry ${retry}/${retries}`);
                    continue;
                }
                throw error;
            }
        }
    }

    /**
     * Encode flux data for transmission
     */
    encodeFlux(fluxList) {
        const data = [];
        const sampleFreq = this.firmwareInfo.sampleFreq;
        const nfaThresh = Math.round(150e-6 * sampleFreq); // 150μs
        const nfaPeriod = Math.round(1.25e-6 * sampleFreq); // 1.25μs

        // Helper to write 28-bit value
        const write28bit = (x) => {
            data.push(1 | ((x << 1) & 0xff));
            data.push(1 | ((x >> 6) & 0xff));
            data.push(1 | ((x >> 13) & 0xff));
            data.push(1 | ((x >> 20) & 0xff));
        };

        // Add dummy flux value at end
        const dummyFlux = Math.round(100e-6 * sampleFreq);
        const allFlux = [...fluxList, dummyFlux];

        for (const val of allFlux) {
            if (val === 0) {
                // Skip zero values
                continue;
            } else if (val < 250) {
                data.push(val);
            } else if (val > nfaThresh) {
                // Very long interval - use SPACE and ASTABLE
                data.push(0xff);
                data.push(FluxOp.Space);
                write28bit(val);
                data.push(0xff);
                data.push(FluxOp.Astable);
                write28bit(nfaPeriod);
            } else {
                // Medium interval
                const high = Math.floor((val - 250) / 255);
                if (high < 5) {
                    data.push(250 + high);
                    data.push(1 + ((val - 250) % 255));
                } else {
                    // Long interval - use SPACE
                    data.push(0xff);
                    data.push(FluxOp.Space);
                    write28bit(val - 249);
                    data.push(249);
                }
            }
        }

        // End of stream
        data.push(0);

        return new Uint8Array(data);
    }

    /**
     * Erase current track
     */
    async eraseTrack(ticks) {
        this.log(`Erasing track (${ticks} ticks)...`);

        const cmd = new Uint8Array(6);
        const view = new DataView(cmd.buffer);
        cmd[0] = Cmd.EraseFlux;
        cmd[1] = 6;
        view.setUint32(2, ticks, true);

        await this.sendCommand(cmd);

        // Sync
        await this.transport.read(1);

        // Get flux status
        await this.getFluxStatus();

        this.log("Track erased");
    }

    /**
     * Set pin level
     */
    async setPin(pin, level) {
        this.log(`Setting pin ${pin} to ${level ? "HIGH" : "LOW"}...`);
        const cmd = new Uint8Array([Cmd.SetPin, 4, pin, level ? 1 : 0]);
        await this.sendCommand(cmd);
        this.log(`Pin ${pin} set to ${level ? "HIGH" : "LOW"}`);
    }

    /**
     * Get pin level
     */
    async getPin(pin) {
        this.log(`Getting pin ${pin} level...`);
        const cmd = new Uint8Array([Cmd.GetPin, 3, pin]);
        await this.sendCommand(cmd);

        const response = await this.transport.read(1);
        const level = response[0] !== 0;

        this.log(`Pin ${pin} is ${level ? "HIGH" : "LOW"}`);
        return level;
    }
}

/**
 * Convert flux data to a Track object
 * @param {object} fluxData - Output from readFlux with { fluxList, indexList }
 * @param {number} sampleFreq - Sample frequency in Hz
 * @param {boolean} isMfm - Whether this is MFM data (true) or FM data (false)
 * @param {boolean} upper - Whether this is upper side (default: false)
 * @param {number} trackNum - Track number (default: 0)
 * @returns {Track} Track object with pulses2Us data
 */
export function fluxToTrack(fluxData, sampleFreq, isMfm = true, upper = false, trackNum = 0) {
    const { fluxList, indexList } = fluxData;

    if (indexList.length < 2) {
        throw new Error("Need at least 2 index pulses to extract one revolution");
    }

    // Find flux transitions for one complete revolution (between first two index pulses)
    const startTicks = indexList[0];
    const endTicks = indexList[1];

    // Extract flux transitions within this revolution
    const revolutionFlux = [];
    let currentTicks = 0;

    for (const fluxTicks of fluxList) {
        currentTicks += fluxTicks;
        if (currentTicks >= startTicks && currentTicks < endTicks) {
            revolutionFlux.push(fluxTicks);
        } else if (currentTicks >= endTicks) {
            // Add partial flux up to end of revolution
            const partial = fluxTicks - (currentTicks - endTicks);
            if (partial > 0) {
                revolutionFlux.push(partial);
            }
            break;
        }
    }

    // Convert flux deltas from ticks to microseconds
    const ticksToUs = 1e6 / sampleFreq;
    const fluxDeltas = revolutionFlux.map((ticks) => ticks * ticksToUs);

    // Create a pulses array
    const pulses2Us = new Uint32Array(IbmDiscFormat.bytesPerTrack);

    // Create a temporary Track object that TrackBuilder expects
    const tempTrack = {
        pulses2Us: pulses2Us,
        length: IbmDiscFormat.bytesPerTrack,
        description: `Track ${trackNum} ${upper ? "upper" : "lower"} (GreaseWeazle flux)`,
    };

    // Use TrackBuilder to populate the track with flux data
    const builder = new TrackBuilder(tempTrack);
    builder.buildFromPulses(fluxDeltas, isMfm);

    // Create and return a proper Track instance
    const track = new Track(upper, trackNum, 0, pulses2Us, tempTrack.description);
    track.length = tempTrack.length; // Update length from builder

    return track;
}

// Export classes and constants
export { GreaseWeazle, Transport, WebSerialTransport, CmdError, Cmd, Ack, ControlCmd, GetInfo, BusType, FluxOp };

// Example usage:
/*
// Create transport
const transport = new WebSerialTransport();
await transport.requestPort();

// Create GreaseWeazle instance
const gw = new GreaseWeazle(transport);

// Connect and initialize
await gw.connect();

// Select drive
await gw.selectDrive(0);
await gw.setBusType(BusType.IBMPC);
await gw.setMotor(0, true);

// Read track
await gw.seek(0, 0);
const fluxData = await gw.readFlux(3);

// Write track
await gw.writeFlux(fluxData.fluxList);

// Cleanup
await gw.setMotor(0, false);
await gw.deselectDrive();
await gw.disconnect();
*/

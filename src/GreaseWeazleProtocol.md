# GreaseWeasel USB Protocol Documentation

This document describes the USB protocol used by GreaseWeasel to communicate with the floppy disk controller hardware.

## Overview

GreaseWeasel uses a USB serial connection to send commands and receive responses. The protocol uses binary messages with specific command codes and data structures.

## USB Communication Parameters

- Baud rates:
  - Normal operation: 9600 baud
  - Clear communications: 10000 baud
- Connection reset procedure:
  1. Clear output buffer
  2. Set baud to ClearComms (10000)
  3. Set baud to Normal (9600)
  4. Clear input buffer
  5. Close and reopen connection

## Command Protocol

### Command Structure

All commands follow this structure:

```
[Command Code (1 byte)] [Length (1 byte)] [Parameters (variable)]
```

The device responds with:

```
[Command Code Echo (1 byte)] [Result Code (1 byte)] [Data (optional)]
```

### Command Codes

| Code | Name          | Description                  |
| ---- | ------------- | ---------------------------- |
| 0    | GetInfo       | Get device information       |
| 1    | Update        | Update firmware              |
| 2    | Seek          | Seek to cylinder             |
| 3    | Head          | Select head                  |
| 4    | SetParams     | Set device parameters        |
| 5    | GetParams     | Get device parameters        |
| 6    | Motor         | Control drive motor          |
| 7    | ReadFlux      | Read flux data from disk     |
| 8    | WriteFlux     | Write flux data to disk      |
| 9    | GetFluxStatus | Get flux operation status    |
| 10   | GetIndexTimes | Get index timing information |
| 11   | SwitchFwMode  | Switch firmware mode         |
| 12   | Select        | Select drive unit            |
| 13   | Deselect      | Deselect drive unit          |
| 14   | SetBusType    | Set floppy bus type          |
| 15   | SetPin        | Set pin level                |
| 16   | Reset         | Reset to power-on defaults   |
| 17   | EraseFlux     | Erase track                  |
| 18   | SourceBytes   | Generate test data           |
| 19   | SinkBytes     | Receive test data            |
| 20   | GetPin        | Get pin level                |
| 21   | TestMode      | Enter test mode              |
| 22   | NoClickStep   | Step without click           |

### Response Codes

| Code | Name          | Description              |
| ---- | ------------- | ------------------------ |
| 0    | Okay          | Command successful       |
| 1    | BadCommand    | Invalid command          |
| 2    | NoIndex       | No index signal detected |
| 3    | NoTrk0        | Track 0 not found        |
| 4    | FluxOverflow  | Flux buffer overflow     |
| 5    | FluxUnderflow | Flux buffer underflow    |
| 6    | Wrprot        | Disk write protected     |
| 7    | NoUnit        | No drive unit selected   |
| 8    | NoBus         | No bus type specified    |
| 9    | BadUnit       | Invalid unit number      |
| 10   | BadPin        | Invalid pin number       |
| 11   | BadCylinder   | Invalid cylinder number  |
| 12   | OutOfSRAM     | Out of SRAM              |
| 13   | OutOfFlash    | Out of Flash memory      |

## Command Details

### GetInfo (0)

Request format:

```
[0x00] [0x03] [GetInfo Index]
```

GetInfo indexes:

- 0: Firmware information
- 1: Bandwidth statistics
- 7: Current drive information

Response for Firmware (32 bytes):

```
struct {
    uint8_t major_version;
    uint8_t minor_version;
    uint8_t is_main_firmware;
    uint8_t max_cmd;
    uint32_t sample_freq;
    uint8_t hw_model;
    uint8_t hw_submodel;
    uint8_t usb_speed;
    uint8_t mcu_id;
    uint16_t mcu_mhz;
    uint16_t mcu_sram_kb;
    uint16_t usb_buf_kb;
    uint8_t reserved[14];
}
```

### Seek (2)

Request format for 8-bit cylinder:

```
[0x02] [0x03] [cylinder (int8_t)]
```

Request format for 16-bit cylinder:

```
[0x02] [0x04] [cylinder (int16_t, little-endian)]
```

### ReadFlux (7)

Request format:

```
[0x07] [0x08] [ticks (uint32_t)] [revolutions (uint16_t)]
```

- `ticks`: Number of sample ticks to read (0 for index-based)
- `revolutions`: Number of index pulses + 1 (0 for tick-based)

Response: Flux data stream (see Flux Data Format below)

After ReadFlux, always call GetFluxStatus to check for errors.

### WriteFlux (8)

Standard request format:

```
[0x08] [0x04] [cue_at_index (uint8_t)] [terminate_at_index (uint8_t)]
```

With hard sectors:

```
[0x08] [0x08] [cue_at_index (uint8_t)] [terminate_at_index (uint8_t)] [hard_sector_ticks (uint32_t)]
```

Followed by encoded flux data stream.

After WriteFlux, send a single byte to sync, then call GetFluxStatus to check for errors.

### GetFluxStatus (9)

Request format:

```
[0x09] [0x02]
```

Response: Standard acknowledgment only (no data)

Must be called after ReadFlux or WriteFlux operations to check for errors like FluxOverflow or FluxUnderflow.

### EraseFlux (17)

Request format:

```
[0x11] [0x06] [ticks (uint32_t)]
```

## Flux Data Format

### Flux Stream Encoding

Flux times are encoded as a stream of bytes with the following scheme:

1. **Short intervals (0-249 ticks)**: Single byte with the value

   - Example: 100 ticks = `[100]`

2. **Medium intervals (250-1524 ticks)**: Two bytes:

   - Calculate: `high = (value - 250) // 255` (will be 0-4)
   - First byte: `250 + high`
   - Second byte: `1 + ((value - 250) % 255)`
   - Example: 300 ticks = `[250, 51]`

3. **Long intervals (≥ 1525 ticks)**:

   - Use SPACE opcode with 28-bit encoding
   - Format: `[0xFF, 0x02, <28-bit encoded value>, 249]`
   - The trailing 249 is subtracted from the final flux value

4. **Very long intervals (> 150μs)**:

   - Threshold: `round(150e-6 * sample_freq)` ticks
   - Uses SPACE opcode for the interval
   - Followed by ASTABLE opcode with 1.25μs period
   - Period: `round(1.25e-6 * sample_freq)` ticks

5. **End of stream**: 0x00

### Special Opcodes

When a 0xFF byte is encountered, it's followed by an opcode:

| Opcode | Name    | Description         |
| ------ | ------- | ------------------- |
| 1      | Index   | Index pulse marker  |
| 2      | Space   | Large flux interval |
| 3      | Astable | No-flux-area marker |

#### Index Opcode (1)

```
[0xFF] [0x01] [28-bit value encoded in 4 bytes]
```

#### Space Opcode (2)

```
[0xFF] [0x02] [28-bit value encoded in 4 bytes]
```

Used for flux intervals ≥ 1525 or > 150μs.

#### Astable Opcode (3)

```
[0xFF] [0x03] [28-bit period encoded in 4 bytes]
```

Used after long intervals (> 150μs) to indicate no-flux-area.

### 28-bit Value Encoding

28-bit values are encoded in 4 bytes using only odd values (LSB always 1):

```
byte0 = 1 | ((value << 1) & 0xFE)  // Bits 0-6, LSB=1
byte1 = 1 | ((value >> 6) & 0xFE)  // Bits 7-13, LSB=1
byte2 = 1 | ((value >> 13) & 0xFE) // Bits 14-20, LSB=1
byte3 = 1 | ((value >> 20) & 0xFE) // Bits 21-27, LSB=1
```

To decode:

```
value = ((byte0 & 0xFE) >> 1) |
        ((byte1 & 0xFE) << 6) |
        ((byte2 & 0xFE) << 13) |
        ((byte3 & 0xFE) << 20)
```

## Pin Control

### SetPin (15)

Request format:

```
[0x0F] [0x04] [pin_number (uint8_t)] [level (uint8_t)]
```

### GetPin (20)

Request format:

```
[0x14] [0x03] [pin_number (uint8_t)]
```

Response:

```
[level (uint8_t)]
```

## Bus Types

- 0: Invalid
- 1: IBM PC
- 2: Shugart

## Sample Timing

All timing values are in units of sample ticks. The sample frequency (in Hz) is obtained from the GetInfo command and typically represents:

- Time resolution for flux transitions
- Index pulse timing
- Motor speed measurements

## Implementation Notes

1. **Error Handling**: Always check the response code. Non-zero indicates an error.
2. **Flux Overflow/Underflow**: May occur during high-density reads/writes. Implement retry logic.
3. **Index Detection**: Some operations require index pulses. Check for NoIndex errors.
4. **Write Verification**: Flux writes should be verified by reading back the track.
5. **Sample Frequency**: Convert between microseconds and ticks using the device's sample frequency.
6. **WriteFlux Sync**: After sending flux data, read one byte to sync with the device before GetFluxStatus.
7. **Dummy Flux**: When encoding flux for write, append a dummy 100μs flux value at the end. This ensures the final real flux value is written completely.
8. **Retry Strategy**: For FluxOverflow/Underflow errors, implement exponential backoff with 5 retries by default.

## Example Command Sequences

### Read Track

1. Select drive unit
2. Set bus type
3. Turn on motor
4. Seek to desired cylinder
5. Select head
6. ReadFlux command
7. GetFluxStatus to check for errors
8. Decode flux stream

### Write Track

1. Select drive unit
2. Set bus type
3. Turn on motor
4. Seek to desired cylinder
5. Select head
6. Optionally erase track
7. WriteFlux command with encoded data
8. GetFluxStatus to check for errors
9. Optionally verify by reading back

## WebUSB Implementation Considerations

### Browser Compatibility

- WebUSB is supported by Chromium-based browsers (Chrome, Edge, Opera)
- Requires HTTPS (except for localhost development)
- User must grant permission via requestDevice()

### JavaScript Implementation

```javascript
// Using WebSerial API (recommended for GreaseWeazle)
const port = await navigator.serial.requestPort();
await port.open({
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
});

// Send command
const cmd = new Uint8Array([0x00, 0x03, 0x00]); // GetInfo Firmware
const writer = port.writable.getWriter();
await writer.write(cmd);
writer.releaseLock();

// Read response
const reader = port.readable.getReader();
const { value, done } = await reader.read();
reader.releaseLock();
```

### Serial-over-USB vs WebUSB

GreaseWeazle appears as a serial port, making Web Serial API more appropriate:

**Web Serial API (Recommended):**

- Direct serial communication
- Supports baud rate changes
- Simpler implementation
- Better error handling

**WebUSB (Alternative):**

- Would require USB vendor/product IDs (check device manager)
- More complex implementation
- Direct USB control
- May need driver adjustments on Windows

### Limitations and Special Considerations

- Both Web Serial and WebUSB require user permission
- Large flux transfers should be chunked to avoid timeouts
- Limited browser support (Chromium-based browsers only)

### Baud Rate Communication Control

GreaseWeazle uses special baud rate values for communication control:

```javascript
// Reset communication with GreaseWeazle
async function resetCommunication(port) {
  // Clear buffers
  await port.close();

  // Set to clear comms baud rate
  await port.open({ baudRate: 10000 });

  // Return to normal baud rate
  await port.close();
  await port.open({ baudRate: 9600 });
}
```

This reset sequence ensures clean communication state, especially important after errors or disconnections.

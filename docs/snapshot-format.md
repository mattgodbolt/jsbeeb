# jsbeeb Snapshot Format (Version 2)

jsbeeb saves emulator state as gzip-compressed JSON files with the extension `.json.gz`. TypedArrays (RAM, palette data, etc.) are encoded as base64 within the JSON. Uncompressed `.json` files are also accepted on load for backward compatibility.

## Top-level structure

```json
{
  "format": "jsbeeb-snapshot",
  "version": 2,
  "model": "BBC B with DFS 1.2",
  "timestamp": "2026-03-15T12:00:00.000Z",
  "media": { "disc1": "sth:Acornsoft/Drogna", "disc1Crc32": -1234567890 },
  "state": { ... }
}
```

| Field       | Type   | Description                                                                     |
| ----------- | ------ | ------------------------------------------------------------------------------- |
| `format`    | string | Always `"jsbeeb-snapshot"`                                                      |
| `version`   | number | Format version (currently `2`)                                                  |
| `model`     | string | jsbeeb model name or synonym (e.g. `"B"`, `"Master"`, `"BBC Master 128 (DFS)"`) |
| `timestamp` | string | ISO 8601 timestamp of when the snapshot was created                             |
| `media`     | object | _(Optional)_ Disc source references for reload on restore (see below)           |
| `state`     | object | The full emulator state (see below)                                             |

### Media references (`media`)

| Field            | Type       | Description                                                      |
| ---------------- | ---------- | ---------------------------------------------------------------- |
| `disc1`          | string     | _(Optional)_ Drive 0 disc source (e.g. `"sth:Acornsoft/Drogna"`) |
| `disc2`          | string     | _(Optional)_ Drive 1 disc source                                 |
| `disc1Crc32`     | number     | _(Optional)_ CRC32 of the original disc 1 image for verification |
| `disc2Crc32`     | number     | _(Optional)_ CRC32 of the original disc 2 image for verification |
| `disc1ImageData` | Uint8Array | _(Optional)_ Embedded original disc 1 image bytes (local files)  |
| `disc2ImageData` | Uint8Array | _(Optional)_ Embedded original disc 2 image bytes (local files)  |
| `disc1Name`      | string     | _(Optional)_ Original filename for embedded disc 1               |
| `disc2Name`      | string     | _(Optional)_ Original filename for embedded disc 2               |

On restore, discs are reloaded from these source references before the FDC state is applied. The source string uses the same schema as URL query parameters (`sth:`, `http://`, `gd:`, etc.).

For locally-loaded files (via file input), the original disc image bytes are embedded in `discNImageData` so the disc can be reconstructed on restore without requiring the user to reload the file manually.

When `discNCrc32` is present, it is compared against the CRC32 of the reloaded disc image. A mismatch shows an error dialog warning that the disc image may have changed since the snapshot was saved.

### Version history

- **v1** — Initial release. CPU, memory, VIA, video, sound, ACIA, ADC.
- **v2** — Added FDC, disc drive, and disc track data. Dirty track persistence, embedded disc image data for local files, and CRC32 verification. v1 snapshots load with FDC state unchanged.

### Imported snapshots

Snapshots can be imported from other emulators. The `importedFrom` field in the top-level object identifies the source:

| Value          | Source                                           |
| -------------- | ------------------------------------------------ |
| `"b-em"`       | B-em snapshot (`.snp` file, v1 or v3)            |
| `"beebem-uef"` | BeebEm UEF save state (`.uef` with 0x046C chunk) |

Imported snapshots use the same `jsbeeb-snapshot` format (version 2). They may include the optional `roms` field (sideways RAM/ROM bank contents) but do not include FDC or disc state (`state.fdc` will be absent).

### Model compatibility

When loading, the snapshot model is compared to the current model using `modelsCompatible()`. This resolves model synonyms (e.g. `"B"` matches `"BBC B with DFS 1.2"`) and treats filesystem variants as compatible (e.g. `"BBC Master 128 (DFS)"` and `"BBC Master 128 (ADFS)"`). If the base machine type differs, a page reload with the correct model is triggered.

## TypedArray encoding

Any TypedArray in the state tree is serialized as:

```json
{
  "__typedArray": true,
  "type": "Uint8Array",
  "data": "<base64-encoded bytes>"
}
```

The `type` field is the constructor name: `Uint8Array`, `Uint16Array`, `Uint32Array`, `Int32Array`, `Float32Array`, or `Float64Array`. Multi-byte types are encoded in the platform's native byte order (little-endian on all supported platforms).

## State object

### CPU (`state.*`)

| Field              | Type       | Description                                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------- |
| `a`                | number     | Accumulator (0-255)                                                                               |
| `x`                | number     | X register (0-255)                                                                                |
| `y`                | number     | Y register (0-255)                                                                                |
| `s`                | number     | Stack pointer (0-255)                                                                             |
| `pc`               | number     | Program counter (0-65535)                                                                         |
| `p`                | number     | Processor flags byte (bits 4-5 always set)                                                        |
| `nmiLevel`         | boolean    | NMI line level                                                                                    |
| `nmiEdge`          | boolean    | NMI edge detected (pending)                                                                       |
| `halted`           | boolean    | CPU halted state                                                                                  |
| `takeInt`          | boolean    | Interrupt pending                                                                                 |
| `romsel`           | number     | ROM bank select register (&FE30)                                                                  |
| `acccon`           | number     | ACCCON register (&FE34, Master only)                                                              |
| `videoDisplayPage` | number     | Video display page offset (0 or 0x8000)                                                           |
| `currentCycles`    | number     | Current cycle counter                                                                             |
| `targetCycles`     | number     | Target cycle counter                                                                              |
| `cycleSeconds`     | number     | Elapsed seconds (float)                                                                           |
| `peripheralCycles` | number     | Peripheral cycle accumulator                                                                      |
| `videoCycles`      | number     | Video cycle accumulator                                                                           |
| `music5000PageSel` | number     | Music 5000 page select                                                                            |
| `ram`              | Uint8Array | RAM contents (128KB, excludes ROMs)                                                               |
| `roms`             | Uint8Array | _(Optional)_ ROM contents (256KB, 16 x 16KB banks). Only present in snapshots imported from b-em. |

**Note:** `interrupt` is not saved — it is reconstructed by the VIA and ACIA `restoreState()` calls which reassert their interrupt lines.

### Scheduler (`state.scheduler`)

| Field   | Type   | Description                           |
| ------- | ------ | ------------------------------------- |
| `epoch` | number | Current scheduler epoch (cycle count) |

Scheduled tasks are not saved directly. Each component saves its task timing as an offset relative to `epoch` and re-registers its tasks on restore.

### VIA (`state.sysvia`, `state.uservia`)

| Field          | Type         | Description                                        |
| -------------- | ------------ | -------------------------------------------------- |
| `ora`          | number       | Output Register A                                  |
| `orb`          | number       | Output Register B                                  |
| `ira`          | number       | Input Register A                                   |
| `irb`          | number       | Input Register B                                   |
| `ddra`         | number       | Data Direction Register A                          |
| `ddrb`         | number       | Data Direction Register B                          |
| `sr`           | number       | Shift Register                                     |
| `t1l`          | number       | Timer 1 Latch (doubled 2MHz ticks)                 |
| `t2l`          | number       | Timer 2 Latch                                      |
| `t1c`          | number       | Timer 1 Counter                                    |
| `t2c`          | number       | Timer 2 Counter                                    |
| `acr`          | number       | Auxiliary Control Register                         |
| `pcr`          | number       | Peripheral Control Register                        |
| `ifr`          | number       | Interrupt Flag Register                            |
| `ier`          | number       | Interrupt Enable Register                          |
| `t1hit`        | boolean      | Timer 1 has expired                                |
| `t2hit`        | boolean      | Timer 2 has expired                                |
| `portapins`    | number       | Port A pin levels                                  |
| `portbpins`    | number       | Port B pin levels                                  |
| `ca1`          | boolean      | CA1 line level                                     |
| `ca2`          | boolean      | CA2 line level                                     |
| `cb1`          | boolean      | CB1 line level                                     |
| `cb2`          | boolean      | CB2 line level                                     |
| `justhit`      | number       | Timer just-hit flags                               |
| `t1_pb7`       | number       | Timer 1 PB7 output state                           |
| `lastPolltime` | number       | Last polltime epoch                                |
| `taskOffset`   | number\|null | Scheduled task offset from epoch (null if no task) |

System VIA additionally includes:

| Field            | Type    | Description                                 |
| ---------------- | ------- | ------------------------------------------- |
| `IC32`           | number  | IC32 latch (keyboard, sound, screen select) |
| `capsLockLight`  | boolean | Caps lock LED state                         |
| `shiftLockLight` | boolean | Shift lock LED state                        |

### Video (`state.video`)

Contains ~40 scalar fields for display timing and rendering state, plus nested objects:

| Key field                | Type       | Description                                     |
| ------------------------ | ---------- | ----------------------------------------------- |
| `regs`                   | Uint8Array | CRTC registers (32 bytes, first 18 significant) |
| `ulaPal`                 | Int32Array | Resolved 32-bit ABGR palette (16 entries)       |
| `actualPal`              | Uint8Array | Raw palette register values (16 entries)        |
| `ulactrl`                | number     | ULA control register                            |
| `ulaMode`                | number     | Graphics mode (0-3)                             |
| `teletextMode`           | boolean    | MODE 7 active                                   |
| `interlacedSyncAndVideo` | boolean    | Interlace mode active                           |
| `horizCounter`           | number     | Horizontal character counter                    |
| `vertCounter`            | number     | Vertical character row counter                  |
| `scanlineCounter`        | number     | Scanline within character row                   |
| `addr`                   | number     | Current CRTC memory address                     |
| `lineStartAddr`          | number     | Line start address (maback)                     |
| `ula`                    | object     | ULA/NULA state (see below)                      |
| `crtc`                   | object     | CRTC state (`{ curReg }`)                       |
| `teletext`               | object     | SAA5050 teletext chip state                     |

#### ULA (`state.video.ula`)

| Field              | Type       | Description                        |
| ------------------ | ---------- | ---------------------------------- |
| `collook`          | Int32Array | 16-entry NULA colour lookup (ABGR) |
| `flash`            | Uint8Array | 8-entry flash enable flags         |
| `paletteWriteFlag` | boolean    | NULA 2-byte write protocol state   |
| `paletteFirstByte` | number     | First byte of NULA palette write   |
| `paletteMode`      | number     | NULA palette mode                  |
| `horizontalOffset` | number     | NULA horizontal scroll offset      |
| `leftBlank`        | number     | NULA left blank columns            |
| `disabled`         | boolean    | NULA disabled flag                 |
| `attributeMode`    | number     | NULA attribute mode                |
| `attributeText`    | number     | NULA attribute text mode           |

#### Teletext (`state.video.teletext`)

Contains ~20 scalar fields for SAA5050 rendering state. Glyph table references are stored as strings (`"normal"`, `"graphics"`, `"separated"`) rather than serializing the static glyph data.

### Sound chip (`state.soundChip`)

| Field             | Type         | Description                                    |
| ----------------- | ------------ | ---------------------------------------------- |
| `registers`       | Uint16Array  | 4 channel tone/noise period registers          |
| `counter`         | Float32Array | 4 channel counters                             |
| `outputBit`       | boolean[]    | 4 channel output states                        |
| `volume`          | Float32Array | 4 channel volume levels                        |
| `lfsr`            | number       | Noise generator linear feedback shift register |
| `latchedRegister` | number       | Last latched register address                  |
| `residual`        | number       | Sub-sample residual (float)                    |
| `sineOn`          | boolean      | Sine tone generator active                     |
| `sineStep`        | number       | Sine generator step size                       |
| `sineTime`        | number       | Sine generator phase                           |

### ACIA (`state.acia`)

| Field                        | Type         | Description                     |
| ---------------------------- | ------------ | ------------------------------- |
| `sr`                         | number       | Status Register                 |
| `cr`                         | number       | Control Register                |
| `dr`                         | number       | Data Register                   |
| `rs423Selected`              | boolean      | RS-423 mode selected            |
| `motorOn`                    | boolean      | Tape motor state                |
| `tapeCarrierCount`           | number       | Carrier detect counter          |
| `tapeDcdLineLevel`           | boolean      | DCD line level                  |
| `hadDcdHigh`                 | boolean      | DCD high seen flag              |
| `serialReceiveRate`          | number       | Baud rate                       |
| `serialReceiveCyclesPerByte` | number       | Cycles per byte at current rate |
| `txCompleteTaskOffset`       | number\|null | TX complete task offset         |
| `runTapeTaskOffset`          | number\|null | Tape poll task offset           |
| `runRs423TaskOffset`         | number\|null | RS-423 poll task offset         |

### ADC (`state.adc`)

| Field        | Type         | Description                    |
| ------------ | ------------ | ------------------------------ |
| `status`     | number       | Status register                |
| `low`        | number       | Low byte of conversion result  |
| `high`       | number       | High byte of conversion result |
| `taskOffset` | number\|null | Conversion task offset         |

### FDC (`state.fdc`) — _v2+_

The FDC field is present in v2+ snapshots. When loading a v1 snapshot, `state.fdc` is absent and the FDC retains its current state.

The FDC type depends on the model: Intel 8271 for BBC B models, WD1770 for Master models.

#### Intel 8271 (`state.fdc` when model is BBC B)

| Field                | Type         | Description                                    |
| -------------------- | ------------ | ---------------------------------------------- |
| `regs`               | Uint8Array   | 32 internal registers                          |
| `status`             | number       | Status register                                |
| `isResultReady`      | boolean      | Result register has data                       |
| `mmioData`           | number       | MMIO data register                             |
| `mmioClocks`         | number       | MMIO clocks register                           |
| `driveOut`           | number       | Drive output latch                             |
| `shiftRegister`      | number       | Data shift register                            |
| `numShifts`          | number       | Shift count                                    |
| `state`              | number       | State machine state                            |
| `stateCount`         | number       | State counter                                  |
| `stateIsIndexPulse`  | boolean      | Index pulse seen in current state              |
| `crc`                | number       | Running CRC                                    |
| `onDiscCrc`          | number       | CRC read from disc                             |
| `paramCallback`      | number       | Parameter acceptance state                     |
| `indexPulseCallback` | number       | Index pulse callback state                     |
| `timerState`         | number       | Timer state machine                            |
| `callContext`        | number       | Call context state                             |
| `didSeekStep`        | boolean      | Seek step taken flag                           |
| `timerTaskOffset`    | number\|null | Timer task offset from scheduler epoch         |
| `drives`             | object[]     | Array of 2 drive states (see Disc drive below) |

`_currentDrive` is derived from `driveOut` select bits on restore.

#### WD1770 (`state.fdc` when model is Master)

| Field                       | Type         | Description                                    |
| --------------------------- | ------------ | ---------------------------------------------- |
| `controlRegister`           | number       | Drive control register                         |
| `statusRegister`            | number       | Status register                                |
| `trackRegister`             | number       | Track register                                 |
| `sectorRegister`            | number       | Sector register                                |
| `dataRegister`              | number       | Data register                                  |
| `isIntRq`                   | boolean      | INTRQ line level                               |
| `isDrq`                     | boolean      | DRQ line level                                 |
| `doRaiseIntRq`              | boolean      | Pending INTRQ raise                            |
| `isIndexPulse`              | boolean      | Index pulse state                              |
| `isInterruptOnIndexPulse`   | boolean      | Interrupt on index pulse enabled               |
| `isWriteTrackCrcSecondByte` | boolean      | Write track CRC second byte flag               |
| `command`                   | number       | Current command                                |
| `commandType`               | number       | Command type (1, 2, or 3)                      |
| `isCommandSettle`           | boolean      | Command settle flag                            |
| `isCommandWrite`            | boolean      | Command is a write                             |
| `isCommandVerify`           | boolean      | Command verify flag                            |
| `isCommandMulti`            | boolean      | Multi-sector command                           |
| `isCommandDeleted`          | boolean      | Deleted data mark flag                         |
| `commandStepRateMs`         | number       | Step rate in milliseconds                      |
| `state`                     | number       | State machine state                            |
| `timerState`                | number       | Timer state machine                            |
| `stateCount`                | number       | State counter                                  |
| `indexPulseCount`           | number       | Index pulse counter                            |
| `markDetector`              | string       | Mark detector BigInt (serialized as string)    |
| `dataShifter`               | number       | Data shift register                            |
| `dataShiftCount`            | number       | Shift count                                    |
| `deliverData`               | number       | Data byte to deliver                           |
| `deliverIsMarker`           | boolean      | Delivered byte is a marker                     |
| `crc`                       | number       | Running CRC                                    |
| `onDiscTrack`               | number       | Track number read from disc                    |
| `onDiscSector`              | number       | Sector number read from disc                   |
| `onDiscLength`              | number       | Sector length read from disc                   |
| `onDiscCrc`                 | number       | CRC read from disc                             |
| `lastMfmBit`                | boolean      | Last MFM clock/data bit                        |
| `timerTaskOffset`           | number\|null | Timer task offset from scheduler epoch         |
| `drives`                    | object[]     | Array of 2 drive states (see Disc drive below) |

`_currentDrive` is derived from `controlRegister` drive select bits on restore. `markDetector` is a BigInt stored as a decimal string.

### Disc drive (`state.fdc.drives[n]`)

| Field             | Type         | Description                            |
| ----------------- | ------------ | -------------------------------------- |
| `track`           | number       | Physical track position (0-83)         |
| `isSideUpper`     | boolean      | Selected disc side                     |
| `headPosition`    | number       | Head position within track             |
| `pulsePosition`   | number       | Sub-pulse position (0 or 16)           |
| `in32usMode`      | boolean      | Double density (MFM) mode              |
| `spinning`        | boolean      | Drive motor spinning                   |
| `is40Track`       | boolean      | 40-track disc mode                     |
| `timerTaskOffset` | number\|null | Timer task offset from scheduler epoch |
| `disc`            | object\|null | Disc state (null if no disc loaded)    |

### Disc (`state.fdc.drives[n].disc`)

| Field           | Type    | Description                                                                      |
| --------------- | ------- | -------------------------------------------------------------------------------- |
| `tracksUsed`    | number  | Number of tracks with data                                                       |
| `isDoubleSided` | boolean | Disc has data on both sides                                                      |
| `isWriteable`   | boolean | Disc is writeable (not write-protected)                                          |
| `name`          | string  | Disc name/label                                                                  |
| `tracks`        | object  | Track data keyed by `"side:trackNum"` (see below)                                |
| `dirtyTracks`   | object  | Modified track data overlay keyed by `"side:trackNum"` (empty `{}` if no writes) |

Each entry in `tracks` or `dirtyTracks` has:

| Field       | Type        | Description                         |
| ----------- | ----------- | ----------------------------------- |
| `pulses2Us` | Uint32Array | Raw pulse data (2µs resolution)     |
| `length`    | number      | Active track length in 32-bit words |

Track keys are strings like `"false:0"` (lower side, track 0) or `"true:5"` (upper side, track 5).

**Save-to-file vs rewind:** When saving to a file, `tracks` is empty (`{}`) and `dirtyTracks` contains only tracks that have been written since the disc was loaded. On restore, the base disc is first reloaded from the media source (URL or embedded image data), then dirty track overlays are applied on top. This preserves disc writes (e.g. game saves) across save/restore cycles. For in-memory rewind snapshots, `tracks` contains full pulse data with structural sharing: clean tracks share `pulses2Us` references across snapshots, and only tracks written since the previous snapshot are freshly copied. This keeps rewind memory proportional to disc write activity rather than total disc size.

## Known limitations (v2)

- **No tape position** — tape playback position is not saved.
- **ROMs not saved** (in jsbeeb-native snapshots) — ROMs are loaded from files and don't change at runtime. Imported b-em snapshots include ROMs in the optional `roms` field.

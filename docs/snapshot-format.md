# jsbeeb Snapshot Format (Version 1)

jsbeeb saves emulator state as gzip-compressed JSON files with the extension `.json.gz`. TypedArrays (RAM, palette data, etc.) are encoded as base64 within the JSON. Uncompressed `.json` files are also accepted on load for backward compatibility.

## Top-level structure

```json
{
  "format": "jsbeeb-snapshot",
  "version": 1,
  "model": "BBC B with DFS 1.2",
  "timestamp": "2026-03-15T12:00:00.000Z",
  "state": { ... }
}
```

| Field       | Type   | Description                                                                     |
| ----------- | ------ | ------------------------------------------------------------------------------- |
| `format`    | string | Always `"jsbeeb-snapshot"`                                                      |
| `version`   | number | Format version (currently `1`)                                                  |
| `model`     | string | jsbeeb model name or synonym (e.g. `"B"`, `"Master"`, `"BBC Master 128 (DFS)"`) |
| `timestamp` | string | ISO 8601 timestamp of when the snapshot was created                             |
| `state`     | object | The full emulator state (see below)                                             |

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

## Known limitations (v1)

- **FDC state not saved** — disc controller state is not captured. Saving during disc I/O will hang on restore. Save when the disc is idle.
- **No disc data** — modified disc sector contents are not saved. The same disc image must be loaded when restoring.
- **No tape position** — tape playback position is not saved.
- **ROMs not saved** (in jsbeeb-native snapshots) — ROMs are loaded from files and don't change at runtime. Imported b-em snapshots include ROMs in the optional `roms` field.

# jsbeeb Snapshot Format (Version 4)

jsbeeb saves emulator state as gzip-compressed JSON files with the extension `.json.gz`. TypedArrays (RAM, palette data, etc.) are encoded as base64 within the JSON, the larger ones deflated first. Uncompressed `.json` files are also accepted on load for backward compatibility.

## Top-level structure

```json
{
  "format": "jsbeeb-snapshot",
  "version": 4,
  "model": "BBC B with DFS 1.2",
  "coProcessor": false,
  "timestamp": "2026-03-15T12:00:00.000Z",
  "media": { "disc1": "sth:Acornsoft/Drogna", "disc1Crc32": -1234567890 },
  "state": { ... }
}
```

| Field         | Type    | Description                                                                     |
| ------------- | ------- | ------------------------------------------------------------------------------- |
| `format`      | string  | Always `"jsbeeb-snapshot"`                                                      |
| `version`     | number  | Format version (currently `4`)                                                  |
| `model`       | string  | jsbeeb model name or synonym (e.g. `"B"`, `"Master"`, `"BBC Master 128 (DFS)"`) |
| `coProcessor` | boolean | _(v3+)_ Whether a second processor was fitted. Absent means no                  |
| `timestamp`   | string  | ISO 8601 timestamp of when the snapshot was created                             |
| `media`       | object  | _(Optional)_ Disc source references for reload on restore (see below)           |
| `state`       | object  | The full emulator state (see below)                                             |

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
| `disc1Layout`    | string     | _(Optional)_ Track layout drive 0's disc was loaded with         |
| `disc2Layout`    | string     | _(Optional)_ Track layout drive 1's disc was loaded with         |

On restore, discs are reloaded from these source references before the FDC state is applied. The source string uses the same schema as URL query parameters (`sth:`, `http://`, `gd:`, etc.); a bare filename names a built-in disc served from `discs/`, which is how a state saved from a default boot records its disc.

`discNLayout` is `"contiguous"` (logical track N on physical track N) or `"expanded40"` (logical track N on physical track 2N, as a 40-track drive writes). It is recorded because the dirty track overlays below are indexed by physical track: reloading the disc pins it to the layout saved here rather than working the layout out again from the image. Absent means `"contiguous"`, which is what every snapshot written before layout detection existed holds.

For locally-loaded files (via file input), the original disc image bytes are embedded in `discNImageData` so the disc can be reconstructed on restore without requiring the user to reload the file manually.

When `discNCrc32` is present, it is compared against the CRC32 of the reloaded disc image. The restore fails with an error if the reloaded image does not match, or if the state carries a CRC but no source and the disc already in the drive does not match; the dirty track overlays below would otherwise be laid over the wrong disc.

### Version history

- **v1** — Initial release. CPU, memory, VIA, video, sound, ACIA, ADC.
- **v2** — Added FDC, disc drive, and disc track data. Dirty track persistence, embedded disc image data for local files, and CRC32 verification. v1 snapshots load with FDC state unchanged.
- **v3** — Added second processor state (`state.tube`) and the top-level `coProcessor` flag. Nothing before v3 captured tube state, so earlier snapshots are always host-only and load into a machine without a co-processor unchanged.
- **v4**: TypedArrays of 1024 bytes or more are deflated before their base64 encoding (see [TypedArray encoding](#typedarray-encoding)). The state itself is unchanged, and plain base64 arrays from earlier versions still load.

The benchmark workloads in `public/benchmarks` are snapshots in this format, restored in CI, which also checks they are what `npm run benchmark:workloads` builds (`npm run test:benchmark-workloads`). After a change to the snapshot format or to what a boot does, that command rebuilds them.

### Imported snapshots

Snapshots can be imported from other emulators. The `importedFrom` field in the top-level object identifies the source:

| Value          | Source                                           |
| -------------- | ------------------------------------------------ |
| `"b-em"`       | B-em snapshot (`.snp` file, v1 or v3)            |
| `"beebem-uef"` | BeebEm UEF save state (`.uef` with 0x046C chunk) |

Imported snapshots use the same `jsbeeb-snapshot` format (version 3) and do not include FDC, disc or touchscreen state (`state.fdc` and `state.touchScreen` will be absent).

B-em snapshots include the full ROM contents in the `roms` field (256KB, all 16 banks). BeebEm UEF snapshots include only the sideways RAM banks they saved, in `swram` and `swramBankMask`.

### Model compatibility

When loading, the snapshot's model must match the current one. Names are resolved through the model list, so synonyms and old names match (e.g. `"B"` matches `"BBC B with DFS 1.2"`), but the result must be the same model: filesystem variants are separate models and so are _not_ interchangeable (e.g. `"BBC Master 128 (DFS)"` does not match `"BBC Master 128 (ADFS)"`).

The co-processor is emulation config rather than part of the model, so the model name cannot tell a Master Turbo from a plain Master. The `coProcessor` flag is therefore compared separately, and a mismatch is an error.

If the models or co-processor settings differ, the snapshot is stashed in `sessionStorage` under `jsbeeb-pending-state` and the page reloads with the snapshot's model and co-processor setting in the query string and the page's own startup actions (`autoboot`, `autochain`, `autorun`, `autotype`, `loadBasic`, `embedBasic` and `patch`) left out, picking the state back up on the way in.

Loading a pre-v3 snapshot while a co-processor is fitted therefore restarts the machine without one, since such a snapshot describes a host-only machine.

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

From v4, a TypedArray of 1024 bytes or more is written with an `encoding` field, and its `data` is the base64 of those bytes compressed as a zlib stream (RFC 1950 deflate, level 1):

```json
{
  "__typedArray": true,
  "type": "Uint32Array",
  "encoding": "deflate",
  "data": "<base64-encoded zlib stream>"
}
```

No `encoding` field means plain base64, which is how every array before v4 and every smaller array is written. A reader accepts either form wherever an array appears, so the two may be mixed in one snapshot.

## State object

### CPU (`state.*`)

| Field                 | Type       | Description                                                                                                   |
| --------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| `a`                   | number     | Accumulator (0-255)                                                                                           |
| `x`                   | number     | X register (0-255)                                                                                            |
| `y`                   | number     | Y register (0-255)                                                                                            |
| `s`                   | number     | Stack pointer (0-255)                                                                                         |
| `pc`                  | number     | Program counter (0-65535)                                                                                     |
| `p`                   | number     | Processor flags byte (bits 4-5 always set)                                                                    |
| `nmiLevel`            | boolean    | NMI line level, the OR of every device's line (see below)                                                     |
| `nmiEdge`             | boolean    | NMI edge detected (pending)                                                                                   |
| `halted`              | boolean    | CPU halted state                                                                                              |
| `takeInt`             | boolean    | Interrupt pending                                                                                             |
| `stoppedAtBreakpoint` | boolean    | _(Optional)_ An instruction or interrupt hook (execute or IRQ stops, run-until) halted it at `pc` (see below) |
| `romsel`              | number     | ROM bank select register (&FE30)                                                                              |
| `acccon`              | number     | ACCCON register (&FE34, Master only)                                                                          |
| `videoDisplayPage`    | number     | Video display page offset (0 or 0x8000)                                                                       |
| `currentCycles`       | number     | Current cycle counter                                                                                         |
| `targetCycles`        | number     | Target cycle counter                                                                                          |
| `cycleSeconds`        | number     | Elapsed seconds (float)                                                                                       |
| `peripheralCycles`    | number     | Peripheral cycle accumulator                                                                                  |
| `videoCycles`         | number     | Video cycle accumulator                                                                                       |
| `music5000PageSel`    | number     | Music 5000 page select                                                                                        |
| `ram`                 | Uint8Array | RAM contents (64KB; on a Master, ANDY at 0x8000, HAZEL at 0x9000 and LYNNE at 0xB000)                         |
| `roms`                | Uint8Array | _(Optional)_ ROM contents (256KB, 16 x 16KB banks). Present in b-em imports and shared session joins.         |
| `swram`               | Uint8Array | _(Optional)_ Sideways RAM banks, 16KB each, back to back in ascending bank order (see below)                  |
| `swramBankMask`       | number     | _(Optional)_ Which banks `swram` holds: bit n set for bank n                                                  |

`swram` holds every bank the model has as sideways RAM (banks 0-7 on a B, mask `0x00FF`; 4-7 on a Master, mask `0x00F0`; none on a stock B or an Atom). The mask is saved rather than read from the model, so a later change to a model's banks cannot misplace an older file's. Both fields are left out when `roms` already carries every bank. On restore each bank in the mask overwrites only that bank, so the ROMs jsbeeb has loaded stay as they are. Snapshots from before sideways RAM was saved have neither field, and then sideways RAM keeps its current contents, so it needed no format version bump.

**Note:** `interrupt` is not saved — it is reconstructed from the VIA and ACIA state, which reasserts their interrupt lines.

Snapshots written before `ram` was 64KB, and earlier b-em and BeebEm imports, hold 128KB of `ram`. They still load: only the first 64KB is used, as the rest was never mapped, so it needed no format version bump.

The NMI level is rebuilt the same way: the CPU clears every device's line and each device re-drives its own, the FDC from its restored registers and econet from its live state (econet state itself is not saved). `nmiLevel` is read back only when the snapshot carries no FDC state (v1 and imported snapshots), where it stands in for the disc controller's line. `nmiEdge` is applied after the devices have re-driven their lines, so a line coming back up on restore is not mistaken for a fresh edge.

A state restored with `stoppedAtBreakpoint` set is stopped where it was saved: the next run executes the instruction at `pc` without any breakpoint stopping there again, and every instruction hook, including one added since, is still called for it. The browser loads such a state into the debugger, paused at `pc`. Older snapshots and the b-em and BeebEm imports lack the field, and absent means false (no stop, so a breakpoint at `pc` fires at once), so it needed no format version bump.

### Scheduler (`state.scheduler`)

| Field   | Type   | Description                           |
| ------- | ------ | ------------------------------------- |
| `epoch` | number | Current scheduler epoch (cycle count) |

Scheduled tasks are not saved directly. Each component saves its task timing as an offset relative to `epoch` and re-registers its tasks on restore.

### VIA (`state.sysvia`, `state.uservia`)

| Field                | Type         | Description                                                      |
| -------------------- | ------------ | ---------------------------------------------------------------- |
| `ora`                | number       | Output Register A                                                |
| `orb`                | number       | Output Register B                                                |
| `ira`                | number       | Input Register A                                                 |
| `irb`                | number       | Input Register B                                                 |
| `ddra`               | number       | Data Direction Register A                                        |
| `ddrb`               | number       | Data Direction Register B                                        |
| `sr`                 | number       | Shift Register                                                   |
| `t1l`                | number       | Timer 1 Latch (doubled 2MHz ticks)                               |
| `t2l`                | number       | Timer 2 Latch                                                    |
| `t1c`                | number       | Timer 1 Counter                                                  |
| `t2c`                | number       | Timer 2 Counter (just the low byte's count in shift mode 100)    |
| `acr`                | number       | Auxiliary Control Register                                       |
| `pcr`                | number       | Peripheral Control Register                                      |
| `ifr`                | number       | Interrupt Flag Register                                          |
| `ier`                | number       | Interrupt Enable Register                                        |
| `t1hit`              | boolean      | Timer 1 has expired                                              |
| `t2hit`              | boolean      | Timer 2 has expired                                              |
| `t2High`             | number       | T2 high byte in shift mode 100; split from `t2c` when absent     |
| `portapins`          | number       | Port A pin levels                                                |
| `portbpins`          | number       | Port B pin levels                                                |
| `ca1`                | boolean      | CA1 line level                                                   |
| `ca2`                | boolean      | CA2 line level                                                   |
| `cb1`                | boolean      | CB1 line level                                                   |
| `cb2`                | boolean      | CB2 line level                                                   |
| `justhit`            | number       | Timer just-hit flags                                             |
| `t1_pb7`             | number       | Timer 1 PB7 output state                                         |
| `lastPolltime`       | number       | Last polltime epoch                                              |
| `taskOffset`         | number\|null | Scheduled task offset from epoch (null if no task)               |
| `ca2PulseTaskOffset` | number\|null | Offset at which a pulse-mode CA2 returns high (null if no pulse) |
| `cb2PulseTaskOffset` | number\|null | Offset at which a pulse-mode CB2 returns high (null if no pulse) |

`ca2PulseTaskOffset` and `cb2PulseTaskOffset` are absent from snapshots written before CA2/CB2 pulses had a width, and from imported snapshots; absent means no pulse is in flight.

System VIA additionally includes:

| Field               | Type         | Description                                                                       |
| ------------------- | ------------ | --------------------------------------------------------------------------------- |
| `IC32`              | number       | IC32 latch (keyboard, sound, screen select)                                       |
| `keyScanTaskOffset` | number\|null | Offset at which the autoscan next sets the CA2 flag for a held key (null if none) |

During autoscan, `ca2` is true while the scan finds a held key: it stands for the pulse train the scan puts on the line, not one level. `keyScanTaskOffset` is set after the CA2 flag is cleared while that is so. It is absent from snapshots written before it was saved and from imported snapshots; absent means none is pending.

The caps lock and shift lock lights are IC32 bits 6 and 7 (lit when clear), so they are not saved. Snapshots written before this also hold `capsLockLight` and `shiftLockLight`; restore ignores them.

### Atom PPIA (`state.atomppia`)

Present only on the Atom.

| Field             | Type       | Description                                          |
| ----------------- | ---------- | ---------------------------------------------------- |
| `latcha`          | number     | Port A output latch (keyboard row, VDG mode)         |
| `latchc`          | number     | Port C latch (output bits 0-3, input bits 4-7)       |
| `portapins`       | number     | Port A pin levels                                    |
| `portbpins`       | number     | Always 0; port B reads come from the keyboard matrix |
| `portcpins`       | number     | Port C pin levels                                    |
| `creg`            | number     | Last control register write                          |
| `keys`            | number[][] | Keyboard matrix, 1 where a key is down               |
| `keyboardEnabled` | boolean    | Whether host key events reach the matrix             |
| `lastSpeakerBit`  | number     | Port C bit 2 as last sent to the speaker             |

Older snapshots also carry `latchb`, which was always 0 since port B is input only; it is ignored on restore.

### Video (`state.video`)

Contains ~40 scalar fields for display timing and rendering state, plus nested objects:

| Key field                 | Type       | Description                                                                    |
| ------------------------- | ---------- | ------------------------------------------------------------------------------ |
| `regs`                    | Uint8Array | CRTC registers (32 bytes, first 18 significant)                                |
| `ulaPal`                  | Int32Array | Resolved 32-bit ABGR palette (16 entries)                                      |
| `actualPal`               | Uint8Array | Raw palette register values (16 entries)                                       |
| `ulactrl`                 | number     | ULA control register                                                           |
| `ulaMode`                 | number     | Graphics mode (0-3)                                                            |
| `teletextMode`            | boolean    | MODE 7 active                                                                  |
| `interlacedSyncAndVideo`  | boolean    | Interlace mode active                                                          |
| `hsyncCount`              | number     | Hsyncs seen, modulo 2500, for the PAL V-switch parity. Absent means 0          |
| `subcarrierPhase`         | number     | PAL subcarrier phase in cycles, 0 to 1, at the current line. Absent means 0    |
| `lineBaseEven`            | number     | `hsyncCount` under which framebuffer row 0 was drawn. Absent means 0           |
| `lineBaseOdd`             | number     | `hsyncCount` under which framebuffer row 1 was drawn. Absent means 0           |
| `phaseBaseEven`           | number     | `subcarrierPhase` under which framebuffer row 0 was drawn. Absent means 0      |
| `phaseBaseOdd`            | number     | `subcarrierPhase` under which framebuffer row 1 was drawn. Absent means 0      |
| `frameStartX`             | number     | Where `bitmapX` would be with no hsync since flyback. Absent means `bitmapX`   |
| `horizCounter`            | number     | Horizontal character counter                                                   |
| `vertCounter`             | number     | Vertical character row counter                                                 |
| `scanlineCounter`         | number     | Scanline within character row                                                  |
| `addr`                    | number     | Current CRTC memory address                                                    |
| `lineStartAddr`           | number     | Line start address (maback)                                                    |
| `inVSync`                 | boolean    | Vsync output, to the System VIA's CA1 and the SAA5050's DEW                    |
| `inLineVSync`             | boolean    | Vsync timed from the start of the line. Absent means `inVSync`                 |
| `hadVSyncThisRow`         | boolean    | The line-start vsync has started in this row                                   |
| `inHalfLineVSync`         | boolean    | Vsync timed from half R0, for the even interlace field. Absent means `inVSync` |
| `hadHalfLineVSyncThisRow` | boolean    | The half-line vsync has started in this row. Absent means `hadVSyncThisRow`    |
| `ula`                     | object     | ULA/NULA state (see below)                                                     |
| `crtc`                    | object     | CRTC state (`{ curReg }`)                                                      |
| `teletext`                | object     | SAA5050 teletext chip state                                                    |
| `video6847`               | object     | MC6847 VDG state, Atom only (see below)                                        |

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

Whether a VideoNuLA is fitted is the machine's setting, not part of the snapshot. Without one, `disabled` is always true and the NULA fields are always their power-on values: restoring onto such a machine ignores the saved NULA fields and the saved `ulaPal`, recomputing the palette from `actualPal`. A machine with a VideoNuLA restores them as saved, `disabled` included.

#### Teletext (`state.video.teletext`)

Contains ~20 scalar fields for SAA5050 rendering state. Glyph table references are stored as strings (`"normal"`, `"graphics"`, `"separated"`) rather than serializing the static glyph data.

#### MC6847 (`state.video.video6847`)

Present only on the Atom. Atom snapshots written before it was saved lack it, and absent means the VDG keeps its current state, the same fallback as the teletext adaptor's, so it needed no format version bump.

| Field               | Type    | Description                                                                                              |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `horizCounter`      | number  | VDG cycle within the line, 0-228                                                                         |
| `vertCounter`       | number  | Line within the field, 0-262                                                                             |
| `scanlineCounter`   | number  | Scanline within the current row of the mode                                                              |
| `addr`              | number  | Next video memory address, as an offset from 0x8000                                                      |
| `lineStartAddr`     | number  | Address the current row starts at                                                                        |
| `nextLineStartAddr` | number  | Address the next row starts at                                                                           |
| `bitmapX`           | number  | Framebuffer column being drawn                                                                           |
| `bitmapY`           | number  | Framebuffer row being drawn                                                                              |
| `frameCount`        | number  | Fields drawn, which picks the one in five that is painted                                                |
| `inHSync`           | boolean | Horizontal sync pending                                                                                  |
| `inVSync`           | boolean | In field sync (FS low)                                                                                   |
| `lastmode`          | number  | Mode the geometry was last set for (port A bits 4-7, every text mode as 0); `0xff` before the first poll |
| `dispEnabled`       | number  | Horizontal, vertical and frame-skip display enable bits                                                  |
| `bordercolour`      | number  | Border colour latched at the last field sync edge (0 black, 1 green or buff)                             |
| `vdgCycles`         | number  | VDG cycles owed but not yet run (float)                                                                  |
| `charTime`          | number  | VDG cycles left until the next character                                                                 |
| `cpuAddr`           | number  | CPU's last write to RAM not yet seen by the VDG, read instead of `addr` for snow                         |

The pixel geometry (`pixelsPerChar`, `pixelsPerBit`, `bpp` and the lines per row) follows from `lastmode` and is recomputed on restore. The mode bits themselves are read from the PPIA's port A each time the VDG runs, so they are saved with the PPIA.

#### Fake video (`state.video` without a picture)

A machine built with `FakeVideo` (TestMachine, or the page's `fakeVideo` option; `FakeAtomVideo` on the Atom) saves only where it is in the field instead of the fields above. Absent fields, as in snapshots written before it kept them, mean the start of a fresh field.

| Field    | Type    | Description                                                                   |
| -------- | ------- | ----------------------------------------------------------------------------- |
| `cycles` | number  | Cycles into the current field (2MHz on the BBC, 1MHz on the Atom)             |
| `inSync` | boolean | In the vsync pulse (the BBC's System VIA CA1) or the Atom's field sync (PPIA) |

### Sound chip (`state.soundChip`)

| Field             | Type         | Description                                          |
| ----------------- | ------------ | ---------------------------------------------------- |
| `registers`       | Uint16Array  | 4 channel tone/noise period registers                |
| `counter`         | Float32Array | 4 channel counters                                   |
| `outputBit`       | boolean[]    | 4 channel output states                              |
| `volume`          | Float32Array | 4 channel volume levels                              |
| `lfsr`            | number       | Noise generator linear feedback shift register       |
| `latchedRegister` | number       | Last latched register address                        |
| `residual`        | number       | Sub-sample residual (float)                          |
| `sineOn`          | boolean      | Sine tone generator active                           |
| `sineStep`        | number       | Sine generator step size                             |
| `sineTime`        | number       | Sine generator phase                                 |
| `dcPrevIn`        | number       | DC blocker previous input (0 if absent)              |
| `dcPrevOut`       | number       | DC blocker previous output (0 if absent)             |
| `speakerBit`      | number       | Atom only: the speaker's level, 0 or 1 (0 if absent) |

### ACIA (`state.acia`)

| Field                  | Type         | Description                                                                        |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `sr`                   | number       | Status Register                                                                    |
| `cr`                   | number       | Control Register                                                                   |
| `dr`                   | number       | Data Register                                                                      |
| `rs423Selected`        | boolean      | RS-423 mode selected                                                               |
| `motorOn`              | boolean      | Tape motor state                                                                   |
| `playPressed`          | boolean      | The recorder's PLAY latch; absent in older snapshots, which restore with PLAY down |
| `tapeCarrierCount`     | number       | Carrier detect counter                                                             |
| `tapeDcdLineLevel`     | boolean      | DCD line level                                                                     |
| `hadDcdHigh`           | boolean      | DCD high seen flag                                                                 |
| `serialReceiveRate`    | number       | Receive baud rate                                                                  |
| `serialTransmitRate`   | number       | Transmit baud rate                                                                 |
| `txCompleteTaskOffset` | number\|null | TX complete task offset                                                            |
| `runTapeTaskOffset`    | number\|null | Tape poll task offset                                                              |
| `runRs423TaskOffset`   | number\|null | RS-423 poll task offset                                                            |

### ADC (`state.adc`)

| Field        | Type         | Description                    |
| ------------ | ------------ | ------------------------------ |
| `status`     | number       | Status register                |
| `low`        | number       | Low byte of conversion result  |
| `high`       | number       | High byte of conversion result |
| `taskOffset` | number\|null | Conversion task offset         |

### Touchscreen (`state.touchScreen`)

| Field            | Type         | Description                                          |
| ---------------- | ------------ | ---------------------------------------------------- |
| `mode`           | number       | Mode selected by the guest's `M<n>.` command         |
| `outBuffer`      | number[]     | Bytes queued to send to the guest, oldest first      |
| `pollTaskOffset` | number\|null | Position report task offset (null if polling is off) |

Absent from snapshots written before the touchscreen was saved, and from imported ones. Absent means the
touchscreen keeps whatever state it currently holds, unpolled, exactly as before.

The pointer position and button state are not saved: like the keyboard, they are host input and are refreshed by the next mouse event.

### Teletext adaptor (`state.teletextAdaptor`)

Present only when the Acorn teletext adaptor was fitted. Absent means the adaptor, if one is fitted now, keeps its current state, the same fallback as a v1 snapshot's missing FDC. Because absence is already the well-defined case, adding this field did not need a format version bump: v3 readers that predate it ignore it, and readers that know it treat an older v3 snapshot as "adaptor state unchanged".

| Field            | Type       | Description                                              |
| ---------------- | ---------- | -------------------------------------------------------- |
| `teletextStatus` | number     | Status register, including the INT, DOR and FSYN latches |
| `teletextInts`   | boolean    | Whether interrupts are enabled                           |
| `teletextEnable` | boolean    | Whether the adaptor is enabled                           |
| `channel`        | number     | Selected channel, 0-3                                    |
| `currentFrame`   | number     | Playback position within the channel's stream            |
| `rowPtr`         | number     | Row register                                             |
| `colPtr`         | number     | Column pointer within the current row                    |
| `pollCount`      | number     | Cycles accumulated towards the next field                |
| `frameBuffer`    | number[][] | 16 rows of 64 bytes as the adaptor last filled them      |

The IRQ line is not saved: it follows from `teletextInts` and the INT latch in `teletextStatus`, in the same way the host's `interrupt` follows from the VIA and ACIA state.

The broadcast stream itself (`teletext/txtN.dat`, around 5MB a channel) is not saved. On restore, a channel differing from the one already loaded is fetched again and its playback restarts from the beginning of the stream, exactly as switching channel does on a running machine. `totalFrames` follows from the stream and is likewise recomputed rather than saved.

### FDC (`state.fdc`) — _v2+_

The FDC field is present in v2+ snapshots. When loading a v1 snapshot, `state.fdc` is absent and the FDC retains its current state.

The FDC type depends on the model: Intel 8271 for BBC B models, WD1770 for Master models.

#### Intel 8271 (`state.fdc` when model is BBC B)

| Field                | Type         | Description                                                     |
| -------------------- | ------------ | --------------------------------------------------------------- |
| `regs`               | Uint8Array   | 32 internal registers                                           |
| `status`             | number       | Status register                                                 |
| `isResultReady`      | boolean      | Result register has data                                        |
| `mmioData`           | number       | MMIO data register                                              |
| `mmioClocks`         | number       | MMIO clocks register                                            |
| `driveOut`           | number       | Drive output latch                                              |
| `shiftRegister`      | number       | Data shift register                                             |
| `numShifts`          | number       | Shift count                                                     |
| `state`              | number       | State machine state                                             |
| `stateCount`         | number       | State counter                                                   |
| `stateIsIndexPulse`  | boolean      | Index pulse seen in current state                               |
| `crc`                | number       | Running CRC                                                     |
| `onDiscCrc`          | number       | CRC read from disc                                              |
| `paramCallback`      | number       | Parameter acceptance state                                      |
| `indexPulseCallback` | number       | Index pulse callback state                                      |
| `timerState`         | number       | Timer state machine                                             |
| `callContext`        | number       | Call context state                                              |
| `didSeekStep`        | boolean      | Seek step taken flag                                            |
| `ready`              | boolean      | The Model B's index-derived ready latch for the selected drive  |
| `readyPulses`        | number       | Index pulses seen in time since selection or the last timeout   |
| `sinceIndexPulse`    | number\|null | Cycles since the last index pulse, null if none since selection |
| `timerTaskOffset`    | number\|null | Timer task offset from scheduler epoch                          |
| `drives`             | object[]     | Array of 2 drive states (see Disc drive below)                  |

`_currentDrive` is derived from `driveOut` on restore: its select bits, and none while LOAD HEAD is low.

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

| Field             | Type         | Description                                                       |
| ----------------- | ------------ | ----------------------------------------------------------------- |
| `track`           | number       | Physical track position (0-83)                                    |
| `isSideUpper`     | boolean      | Selected disc side                                                |
| `headPosition`    | number       | Head position within track                                        |
| `pulsePosition`   | number       | Sub-pulse position (0 or 16)                                      |
| `in32usMode`      | boolean      | Double density (MFM) mode                                         |
| `spinning`        | boolean      | Drive motor spinning                                              |
| `speed`           | number       | Disc speed as a fraction of 300 rpm, spinning up or coasting down |
| `is40Track`       | boolean      | Drive double steps for a 40 track disc                            |
| `timerTaskOffset` | number\|null | Timer task offset from scheduler epoch; set while the disc turns  |
| `disc`            | object\|null | Disc state (null if no disc loaded)                               |

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

### Second processor (`state.tube`) — _v3+_

Present only when a co-processor was fitted.

| Field      | Type       | Description                                                             |
| ---------- | ---------- | ----------------------------------------------------------------------- |
| `a`        | number     | Parasite accumulator                                                    |
| `x`        | number     | Parasite X register                                                     |
| `y`        | number     | Parasite Y register                                                     |
| `s`        | number     | Parasite stack pointer                                                  |
| `pc`       | number     | Parasite program counter                                                |
| `p`        | number     | Parasite status flags as a byte                                         |
| `nmiLevel` | boolean    | Parasite NMI line level                                                 |
| `nmiEdge`  | boolean    | Whether a parasite NMI edge is pending                                  |
| `takeInt`  | boolean    | Whether an interrupt is to be taken before the next instruction         |
| `cycles`   | number     | Cycles owed to the parasite, fractional; it has no scheduler of its own |
| `romPaged` | boolean    | Whether the boot ROM is paged in at `0xF000`                            |
| `memory`   | Uint8Array | 64KB of parasite RAM                                                    |
| `rom`      | Uint8Array | _(Optional)_ 4KB parasite ROM, only when `includeRoms` is set           |
| `ula`      | object     | Tube ULA state (see below)                                              |

#### Tube ULA (`state.tube.ula`)

| Field                          | Type         | Description                                         |
| ------------------------------ | ------------ | --------------------------------------------------- |
| `internalStatusRegister`       | number       | Control flags (IRQ/NMI enables, R3 two-byte mode)   |
| `hostStatus`                   | Uint8Array   | Status of registers 1-4 as the host sees them       |
| `parasiteStatus`               | Uint8Array   | Status of registers 1-4 as the parasite sees them   |
| `parasiteToHostData`           | Uint8Array[] | The four parasite-to-host FIFOs (R1 holds 24 bytes) |
| `hostToParasiteData`           | Uint8Array[] | The four host-to-parasite FIFOs                     |
| `parasiteToHostFifoByteCount1` | number       | Bytes waiting in the parasite-to-host R1 FIFO       |
| `parasiteToHostFifoByteCount3` | number       | Bytes waiting in the parasite-to-host R3 FIFO       |
| `hostToParasiteFifoByteCount3` | number       | Bytes waiting in the host-to-parasite R3 FIFO       |
| `parasiteNmi`                  | boolean      | Whether the ULA is holding an NMI request           |

The IRQ and reset lines are not saved: they follow from the status registers and FIFO counts above, in the same way the host's `interrupt` follows from the VIA and ACIA state.

The parasite's NMI does not. The ULA latches its request rather than presenting the register 3 condition as a level, so once the parasite takes an NMI the request is retired while the condition that raised it may still hold. `parasiteNmi` is therefore real state and cannot be recomputed. Snapshots written before it existed fall back to the register 3 condition on restore, which is what the emulator used to derive the line from. `nmiLevel` and `nmiEdge` on the parasite itself are saved for the same reason: an edge already taken leaves no trace in the ULA. The ULA is the parasite's only NMI source, so unlike the host's `nmiLevel` the parasite's is restored as saved, before the ULA re-drives the line.

## Known limitations (v3)

- **No tape position**: tape playback position is not saved.
- **BeebEm UEF co-processor state is not imported**: BeebEm records a tube type in its `EmuState` chunk, but jsbeeb does not read it, so a UEF save state taken with a second processor imports as host-only.
- **ROMs not saved** (in jsbeeb-native snapshots): ROMs are loaded from files and don't change at runtime. Sideways RAM is saved, in `swram`. Imported b-em snapshots and shared session joins include ROMs in the optional `roms` field.

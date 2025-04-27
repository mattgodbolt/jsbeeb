# B-Em .snp Snapshot File Format

This document describes the B-Em snapshot file format (`.snp`) to allow compatibility with jsbeeb for testing and verification purposes.

## File Structure Overview

B-Em snapshot files use a modular format with each component saving its state in a separate section. The file starts with a fixed header followed by multiple sections, each with its own header and data.

### File Header

```
Offset  Size    Description
0x00    7       Magic identifier: "BEMSNAP"
0x07    1       Version (current is '3')
```

### Section Format

Each section consists of:

For regular (uncompressed) sections:

```
Offset  Size    Description
0x00    1       Section key (ASCII character identifier)
0x01    2       Section size (little-endian)
0x03    n       Section data (n bytes as specified in size)
```

For compressed sections (using zlib):

```
Offset  Size    Description
0x00    1       Section key with bit 7 set (key | 0x80)
0x01    4       Section size (little-endian)
0x05    n       Compressed section data (n bytes as specified in size)
```

## Section Keys

The following section keys are used:

| Key | Description          | Compressed | Component      |
| --- | -------------------- | ---------- | -------------- |
| 'm' | Model info           | No         | Model          |
| '6' | 6502 CPU state       | No         | 6502 CPU       |
| 'M' | Main memory          | Yes        | Memory         |
| 'S' | System VIA           | No         | System VIA     |
| 'U' | User VIA             | No         | User VIA       |
| 'V' | Video ULA            | No         | Video ULA      |
| 'C' | CRTC state           | No         | CRTC           |
| 'v' | Video state          | No         | Video          |
| 's' | Sound chip (SN76489) | No         | Sound chip     |
| 'A' | ADC state            | No         | ADC            |
| 'a' | System ACIA          | No         | System ACIA    |
| 'r' | Serial ULA           | No         | Serial         |
| 'F' | VDFS state           | No         | VDFS           |
| '5' | Music 5000           | No         | Music 5000     |
| 'p' | Paula sound          | No         | Paula          |
| 'J' | JIM (paged RAM)      | Yes        | JIM memory     |
| 'T' | Tube ULA             | No         | Tube           |
| 'P' | Tube processor       | Yes        | Tube processor |

## Section Data Formats

### 6502 CPU State ('6')

```
Offset  Size    Description
0x00    1       A register
0x01    1       X register
0x02    1       Y register
0x03    1       Processor status flags (packed)
0x04    1       Stack pointer
0x05    2       Program counter (little-endian)
0x07    1       NMI status
0x08    1       Interrupt status
0x09    4       Cycle count (little-endian, 32-bit)
```

The processor status flags are packed as follows:

- Bit 7: N (negative)
- Bit 6: V (overflow)
- Bit 5: Always 1
- Bit 4: B (break)
- Bit 3: D (decimal)
- Bit 2: I (interrupt disable)
- Bit 1: Z (zero)
- Bit 0: C (carry)

### Main Memory ('M')

This section is zlib-compressed and contains:

```
Offset  Size    Description
0x00    1       FE30 latch (memory banking)
0x01    1       FE34 latch (memory banking)
0x02    32KB    RAM contents
0x8002  16KB*16 ROM contents (16 ROM slots)
```

### VIA State ('S' for System VIA, 'U' for User VIA)

Both VIAs use the same structure with the System VIA section ('S') having one additional byte for the IC32 latch:

```
Offset  Size    Description
0x00    1       Output Register A (ORA)
0x01    1       Output Register B (ORB)
0x02    1       Input Register A (IRA)
0x03    1       Input Register B (IRB)
0x04    1       Port A Read Value
0x05    1       Port A Read Value (repeated)
0x06    1       Data Direction Register A (DDRA)
0x07    1       Data Direction Register B (DDRB)
0x08    1       Shift Register (SR)
0x09    1       Auxiliary Control Register (ACR)
0x0A    1       Peripheral Control Register (PCR)
0x0B    1       Interrupt Flag Register (IFR)
0x0C    1       Interrupt Enable Register (IER)
0x0D    4       Timer 1 Latch (T1L) - 32-bit, little-endian
0x11    4       Timer 2 Latch (T2L) - 32-bit, little-endian
0x15    4       Timer 1 Counter (T1C) - 32-bit, little-endian
0x19    4       Timer 2 Counter (T2C) - 32-bit, little-endian
0x1D    1       Timer 1 Hit Flag
0x1E    1       Timer 2 Hit Flag
0x1F    1       CA1 State
0x20    1       CA2 State
```

For System VIA only:

```
0x21    1       IC32 latch (video control)
```

### ACIA State ('a')

```
Offset  Size    Description
0x00    1       Control Register
0x01    1       Status Register
```

### Video ULA State ('V')

```
Offset  Size    Description
0x00    1       Control Register
0x01    16      16 palette entries (1 byte each)
0x11    64      NuLA color palette (4 bytes per color: RGBA, 16 colors)
0x51    1       NuLA palette write flag
0x52    1       NuLA palette first byte
0x53    8       NuLA flash values (8 bytes)
0x5B    1       NuLA palette mode
0x5C    1       NuLA horizontal offset
0x5D    1       NuLA left blank
0x5E    1       NuLA disable flag
0x5F    1       NuLA attribute mode
0x60    1       NuLA attribute text
```

### CRTC State ('C')

```
Offset  Size    Description
0x00    18      CRTC registers (0-17)
0x12    1       Vertical Counter (VC)
0x13    1       Scan Counter (SC)
0x14    1       Horizontal Counter (HC)
0x15    2       Memory Address (MA) - 16-bit, little-endian
0x17    2       Memory Address Backup (MABack) - 16-bit, little-endian
```

### Video State ('v')

```
Offset  Size    Description
0x00    2       Screen X position (scrx) - 16-bit, little-endian
0x02    2       Screen Y position (scry) - 16-bit, little-endian
0x04    1       Odd Clock flag
0x05    4       Video Clocks counter (vidclocks) - 32-bit, little-endian
```

### Sound Chip State ('s')

```
Offset  Size    Description
0x00    16      SN Latch values (16 bytes)
0x10    16      SN Count values (16 bytes)
0x20    16      SN Status values (16 bytes)
0x30    4       SN Volume values (4 bytes)
0x34    1       SN Noise value
0x35    2       SN Shift register - 16-bit, little-endian
```

### ADC State ('A')

```
Offset  Size    Description
0x00    1       ADC Status
0x01    1       ADC Low Byte
0x02    1       ADC High Byte
0x03    1       ADC Latch
0x04    1       ADC Time
```

### Serial ULA State ('r')

```
Offset  Size    Description
0x00    1       Serial Register
```

## Loading B-Em Snapshots

To load a B-Em snapshot:

1. Verify the file header matches "BEMSNAP" with a version between '1' and '3'
2. Parse each section based on its key and size
3. For compressed sections (key & 0x80), decompress using zlib
4. Apply each component's state in the correct order:
   - Model
   - 6502 CPU
   - Memory
   - System VIA
   - User VIA
   - Video ULA
   - CRTC
   - Video state
   - Sound chip
   - Other peripherals

## Compatibility Notes

- Version '3' is the most recent and includes all components
- Earlier versions ('1' and '2') have slightly different formats and fewer components
- For jsbeeb compatibility, focus on the core components: 6502 CPU, memory, and VIAs
- The memory layout might differ between B-Em and jsbeeb, requiring translation
- Version '1' has a different loading order of sections (see `load_state_one` function in savestate.c)
- Version '2' uses a different section header format (see `load_state_two` function)

## Using Snapshots for Testing

B-Em snapshots can be valuable for testing jsbeeb by:

1. Creating known-state snapshots in B-Em for specific tests
2. Loading these snapshots in jsbeeb
3. Running the same code sequence in both emulators
4. Comparing final states to verify emulation accuracy

## Snapshot Generation for Testing

To create useful test snapshots:

1. Start B-Em with a specific configuration
2. Load or type in a test program
3. Run the program to a specific point
4. Save a snapshot using the "Save Snapshot" option
5. Document the exact state and expected behavior
6. Use this snapshot as a starting point for comparison testing

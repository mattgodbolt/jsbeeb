# jsbeeb Save State Implementation Design

This document outlines the design and implementation plan for adding save state functionality to jsbeeb. The goal is to allow users to save the entire emulator state at any point and restore it later, providing a seamless experience when resuming emulation sessions.

## Goals

- Create a comprehensive save state system that captures all necessary emulator state
- Support saving to and loading from browser local storage
- Implement a rewind (time travel) feature using a ring buffer of states
- Provide compatibility with other BBC Micro emulator save state formats
- Ensure the implementation is efficient in terms of storage size and performance
- **Support cross-model state restoration** (e.g., loading a BBC B state into a Master)

## Architecture

The save state system will be built around a central `SaveState` class that coordinates saving and loading state from all emulator components. Each component will implement methods to save and restore its state. The system will also store machine model information to ensure correct restoration across different machine configurations.

### Core Components

1. **SaveState Class**: Manages the overall state serialization and deserialization
2. **Component State Interface**: Standard methods for components to save/restore state
3. **Model Information**: Captures the machine configuration (BBC B, Master, etc.) and peripheral setup
4. **Serialization Module**: Handles converting state to/from storable formats
5. **Storage Interface**: Manages saving to localStorage, files, etc.
6. **Time Machine**: Implements the rewind functionality using a ring buffer
7. **Model Restoration Manager**: Handles reconfiguring the machine when loading states from different models

## Component State Implementation

Each component will need to implement methods to save and restore its state:

### CPU State (6502.js)

- Registers (a, x, y, s, pc)
- Processor flags
- Interrupt and NMI state
- Memory access state
- CPU timing information

### Machine Model State

- BBC Micro model type (B, B+, Master 128, etc.)
- CPU type (6502, 65C02, 65C12)
- FDC type (Intel 8271, WD 1770, etc.)
- Memory configuration (shadow RAM, etc.)
- ROM selection and mapping
- Peripheral configuration (available hardware)

### Memory State

- RAM contents
- ROM selection and mapping
- Shadow RAM configuration (for Master)
- Memory paging state

### Video State (video.js)

- CRTC registers
- ULA state and palette
- Rendering state (scanline, position)
- Display mode
- Teletext state (if applicable)

### Sound State (soundchip.js)

- Sound chip registers
- Tone generator state
- Music 5000 state (if present)

### I/O State

- VIA states (sysvia, uservia)
- ACIA state
- FDC state
- Other peripherals (ADC, serial, econet)

### Timing State (scheduler.js)

- Scheduler epoch
- Scheduled tasks with timing information
- Frame timing and sync state

### Disc/Tape State

- Disc drive state (motor, head position)
- Media state (loaded disc images)
- Tape position and state

## Serialization Format

The save state will be serialized in a structured format with:

1. **Header**: Version, timestamp, metadata
2. **Model Information**: BBC Micro model and configuration details
3. **Component Blocks**: Serialized state for each component
4. **Binary Data**: Efficient storage for large arrays (RAM, etc.)

Two serialization formats will be supported:

- **Binary Format**: Compact representation for storage efficiency
- **JSON Format**: Human-readable format for debugging and inspection

## Storage Implementation

### Local Storage

- Save/load from browser localStorage with size limitation handling
- Fallback to IndexedDB for larger states

### File System

- Export/import save states as files
- Standard file format (.jss - jsbeeb state)

### State Naming and Management

- Named save slots
- Automatic timestamping
- Optional thumbnails of the screen state

## Time Travel (Rewind) Implementation

### State Ring Buffer

- Circular buffer storing recent states
- Configurable buffer size and capture frequency
- Memory-efficient delta encoding between adjacent states

### Rewind Controls

- UI controls for navigating through saved states
- Keyboard shortcuts for quick access
- Visual timeline representation

## Format Compatibility

### B-EM Format Support

- Parser/generator for B-EM save state format
- Mapping between B-EM and jsbeeb component representations

### Other Formats

- Extensible design to support additional formats in the future

## User Interface

### Save/Load Controls

- Buttons for quick save/load
- Menu for named save slots
- Keyboard shortcuts

### State Management

- List view of saved states
- Ability to rename, delete, export states
- State metadata display

## Implementation Phases

1. **Phase 1**: Core SaveState class and component interface
2. **Phase 2**: CPU and memory state implementation
3. **Phase 3**: Video and critical peripherals
4. **Phase 4**: Serialization and local storage
5. **Phase 5**: Remaining components
6. **Phase 6**: Rewind functionality
7. **Phase 7**: Format conversion
8. **Phase 8**: UI integration

## Technical Considerations

### Storage Efficiency

- Typed arrays for binary data
- Simple compression for large blocks
- Delta encoding for rewind buffer

### Timing Accuracy

- Careful handling of cycle counting
- Preservation of interrupt timing
- Frame synchronization

### Compatibility

- Version checking for future-proofing
- Graceful handling of incompatible states

### Debugging Support

- Human-readable JSON format option
- State diffing tools

## Code Organization

```
src/
├── savestate.js         # Core SaveState class
├── savestate/
│   ├── formats.js       # Format converters
│   ├── serializer.js    # Serialization helpers
│   ├── storage.js       # Storage integration
│   └── timemachine.js   # Rewind functionality
```

## API Design (Proposed)

```javascript
// Save state interface
class SaveState {
  constructor(version = 1) { ... }
  serialize() { ... }           // Convert to storable format
  static deserialize(data) { ... } // Restore from stored format
  toJSON() { ... }              // Convert to JSON for debugging
  toFile() { ... }              // Export to file
  static fromFile(file) { ... } // Import from file
  
  // Model handling
  getModelInfo() { ... }        // Get the stored model information
  addModelInfo(model) { ... }   // Store model information
}

// Component interface
class Component {
  saveState(state) { ... }      // Save component state
  loadState(state) { ... }      // Restore component state
}

// Model management interface
class ModelManager {
  static getModelFromSaveState(state) { ... } // Extract model info
  static configureForModel(model) { ... }     // Reconfigure emulator
}

// User-facing API
emulator.saveState() => SaveState      // Create a save state
emulator.saveStateToSlot(name) => void // Save to named slot
emulator.loadState(state) => void      // Load a save state
emulator.loadStateFromSlot(name) => void // Load from named slot
emulator.getStateList() => string[]    // List available states
emulator.deleteState(name) => void     // Delete a state
emulator.rewind(seconds) => void       // Rewind emulation
emulator.getModelInfo() => Object      // Get current machine model info
```

## Testing Strategy

The save state implementation is accompanied by a comprehensive testing strategy to ensure reliability and correctness:

### Unit Testing

- **SaveState Class**: Tests for serialization, deserialization, typed array handling, and nested object structures
- **TimeTravel Class**: Tests for buffer management, state rotation, and timing behavior
- **SaveStateStorage Class**: Tests for localStorage integration, error handling, and state management
- **Component Integration**: Tests for each component's save/load state methods

### Integration Testing

- Tests for complete emulator state saving and restoration
- Tests for state compatibility across different emulator configurations
- Performance testing for large state sizes

### Format Compatibility Testing

- Tests for importing/exporting B-EM format states
- Tests for format version handling and backwards compatibility

### Cross-Model Testing

- Tests for saving state on one model and loading on another
- Tests for proper model detection and reconfiguration
- Tests for handling peripheral differences between models

## Model-Aware State Loading Process

When loading a save state, the system will follow these steps:

1. **Extract Model Information**: Read the model information from the save state
2. **Reconfigure Emulator**: Reconfigure the emulator to match the saved model:
   - Set machine type (B, B+, Master 128, etc.)
   - Adjust CPU type (6502/65C02/65C12)
   - Set up memory layout (standard/shadow RAM)
   - Configure appropriate peripherals (Intel/WD FDC, etc.)
3. **Load Component States**: Load component states in the correct order:
   - First load scheduler state
   - Then load CPU core state
   - Load memory state
   - Load peripheral states in dependency order
4. **Post-Load Validation**: Verify critical state was restored properly

This approach ensures that save states can be safely loaded regardless of the current emulator configuration.

## Conclusion

This save state implementation will significantly enhance the usability of jsbeeb by allowing users to save their progress and resume sessions later. The model-aware design ensures that users can load states across different BBC Micro configurations without compatibility issues. The rewind feature will provide a valuable tool for debugging and exploration. The implementation will be done in phases, with careful attention to component state preservation, model compatibility, storage efficiency, and user experience, all backed by comprehensive testing.

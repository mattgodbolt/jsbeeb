# jsbeeb - JavaScript BBC Micro Emulator

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

jsbeeb is a JavaScript BBC Micro emulator that runs in modern browsers and as an Electron desktop application. It emulates a 32K BBC B (with sideways RAM) and a 128K BBC Master, along with numerous peripherals. The emulator is deployed to https://bbc.xania.org and includes comprehensive processor and timing accuracy tests.

## Development Guidelines

**Always reference CLAUDE.md first** for general development practices including:

- Build and test commands
- Code style guidelines
- Test organization principles
- Code architecture patterns
- Git workflow conventions

## Working Effectively

### Bootstrap and Build Process

Run these commands in order for a fresh setup:

1. **Install dependencies**: `npm install` -- takes 13 seconds. Node.js 22 required (will show warnings with older versions).
2. **Initialize submodules**: `git submodule update --init --recursive` -- required for integration tests. Takes 10 seconds.
3. **Build application**: `npm run build` -- takes 4 seconds. Creates production bundle in `dist/` directory.
4. **NEVER CANCEL**: Full test suite: `npm run test` -- takes 91 seconds total. Set timeout to 120+ seconds.
   - Unit tests: `npm run test:unit` -- takes 7 seconds
   - Integration tests: `npm run test:integration` -- takes 18 seconds (requires submodules)
   - **NEVER CANCEL**: CPU tests: `npm run test:cpu` -- takes 66 seconds. Critical for emulation accuracy.

### Timeout Requirements

- **NEVER CANCEL** CPU tests: Use timeout of 120+ seconds minimum
- Integration tests: Use timeout of 30+ seconds
- Unit tests: Use timeout of 15+ seconds
- Build commands: Use timeout of 10+ seconds

## Manual Testing Requirements

After making changes, ALWAYS validate the emulator functionality:

1. **Run development server**: `npm start` (see CLAUDE.md for important restrictions)
2. **Navigate to**: http://localhost:5173/
3. **Verify emulator loads**: Should see "Loading OS from roms/os.rom", "Loading ROM from roms/BASIC.ROM", "Loading ROM from roms/b/DFS-1.2.rom", "Loading disc from discs/elite.ssd" in console
4. **Check emulator runs**: Virtual MHz counter should show ~8.4, play button should be disabled when running
5. **Verify interface**: BBC Micro screen, navigation menu, disc/cassette controls should be visible
6. **Test basic functionality**: Emulator should show the classic BBC Micro boot screen and respond to keyboard input

### Validation Scenarios

Execute these complete scenarios to verify changes work correctly:

- **Boot sequence**: Emulator loads all ROMs and shows BBC Micro startup
- **Disc loading**: Elite disc loads automatically, F12 (Break) should boot the game
- **Interface interaction**: Menu buttons (Discs, Cassettes, Reset, More) should be functional
- **Emulation state**: Play/pause controls should work, virtual MHz should be displayed

## Repository Knowledge

### Key Directories and Files

```
/
├── src/                    # Main application source
│   ├── main.js            # Web application entry point
│   ├── app/app.js         # Electron application entry
│   ├── 6502.js            # CPU emulation core
│   ├── video.js           # Video system emulation
│   ├── fdc.js             # Floppy disc controller
│   └── ...                # Other emulation components
├── tests/                 # Test suites
│   ├── unit/              # Fast component tests
│   ├── integration/       # End-to-end tests
│   └── test-suite.js      # CPU accuracy tests
├── public/                # Static assets (ROMs, discs, tapes)
├── CLAUDE.md              # Development guidelines (reference this file)
└── package.json           # Dependencies and scripts
```

### Git Submodule Requirements

Integration tests require these submodules:

- `tests/6502_65C02_functional_tests` - Klaus Dormann's 6502 test suite
- `tests/integration/dp111_6502Timing` - Detailed timing tests

Initialize with: `git submodule update --init --recursive`

### Common Issues

- **"Functional tests submodule missing"**: Run `git submodule update --init --recursive`
- **Node version warnings**: Upgrade to Node.js 22 (required in package.json)
- **Test timeouts**: Increase timeout values, especially for CPU tests (66+ seconds)
- **Build warnings about chunk size**: Expected behavior due to large emulation codebase

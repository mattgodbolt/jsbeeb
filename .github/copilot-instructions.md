# jsbeeb - JavaScript BBC Micro Emulator

Always reference these instructions first and fallback to search or bash commands only when you encounter unexpected information that does not match the info here.

jsbeeb is a JavaScript BBC Micro emulator that runs in modern browsers and as an Electron desktop application. It emulates a 32K BBC B (with sideways RAM) and a 128K BBC Master, along with numerous peripherals. The emulator is deployed to https://bbc.xania.org and includes comprehensive processor and timing accuracy tests.

## Working Effectively

### Bootstrap and Build Process

Run these commands in order for a fresh setup:

1. **Install dependencies**: `npm install` -- takes 13 seconds. Node.js 22 required (will show warnings with older versions).
2. **Initialize submodules**: `git submodule update --init --recursive` -- required for integration tests. Takes 10 seconds.
3. **Build application**: `npm run build` -- takes 4 seconds. Creates production bundle in `dist/` directory.
4. **NEVER CANCEL**: Full test suite: `npm run test` -- takes 91 seconds total. Set timeout to 120+ minutes.
   - Unit tests: `npm run test:unit` -- takes 7 seconds
   - Integration tests: `npm run test:integration` -- takes 18 seconds (requires submodules)
   - **NEVER CANCEL**: CPU tests: `npm run test:cpu` -- takes 66 seconds. Critical for emulation accuracy.

### Development Workflow

- **Start development server**: `npm start` -- serves on http://localhost:5173/
- **NEVER directly run npm start** in production or CI - ask user first as specified in CLAUDE.md
- **Format code**: `npm run format` -- takes 4 seconds. Uses Prettier.
- **Lint code**: `npm run ci-checks` -- takes 2 seconds. Uses ESLint.
- **Complete build**: `make dist` -- takes 5 seconds. Runs npm install + npm run build.

### Timeout Requirements

- **NEVER CANCEL** CPU tests: Use timeout of 120+ seconds minimum
- Integration tests: Use timeout of 30+ seconds
- Unit tests: Use timeout of 15+ seconds
- Build commands: Use timeout of 10+ seconds

## Validation

### Manual Testing Requirements

After making changes, ALWAYS validate the emulator functionality:

1. **Run development server**: `npm start`
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

### Pre-commit Validation

ALWAYS run these before committing (CI will fail without them):

- `npm run format` -- formats all code with Prettier
- `npm run ci-checks` -- runs ESLint checks
- `npm run test:unit` -- validates core functionality
- For complete validation: `npm run test` -- runs all tests including CPU accuracy

### Testing Requirements

- **Unit tests**: Fast tests for individual components (7 seconds)
- **Integration tests**: End-to-end emulation scenarios (18 seconds, needs submodules)
- **CPU tests**: Comprehensive 6502/65C02/65C12 processor validation (66 seconds)
- **NEVER CANCEL** CPU tests as they validate emulation accuracy against real hardware

## Common Tasks

### Repository Structure

Key directories and files:

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
├── dist/                  # Build output (generated)
├── package.json           # Dependencies and scripts
├── vite.config.js         # Build configuration
└── README.md              # User documentation
```

### Key Scripts from package.json

```json
{
  "start": "vite", // Development server
  "build": "vite build", // Production build
  "test": "npm-run-all test:*", // All tests
  "test:unit": "vitest run tests/unit --silent",
  "test:integration": "vitest run tests/integration --silent",
  "test:cpu": "node tests/test-suite.js",
  "ci-checks": "eslint .", // Linting for CI
  "format": "prettier --write ." // Code formatting
}
```

### Code Architecture and Patterns

- **ES Modules**: Uses ES2020 with import/export syntax (type: "module" in package.json)
- **Error Handling**: Use try/catch with context-specific error messages
- **Naming**: camelCase for variables/functions, PascalCase for classes
- **Testing**: Vitest for unit/integration, custom CPU test suite
- **Build System**: Vite with source maps, external fs module for browser compatibility
- **Code Style**: Prettier formatting, ESLint with strict rules

### Development Guidelines

From CLAUDE.md:

- **Never commit code unless asked**: Iterate first, then get approval
- **Git branches**: Use `claude/` prefix for branches (e.g., `claude/fix-emulation-bug`)
- **Pre-commit hooks**: Automatically run lint-staged with ESLint
- **Test isolation**: Use `vi.spyOn()` with `vi.restoreAllMocks()` in `afterEach`
- **Constants**: Use PascalCase for module constants, avoid magic numbers
  Integration tests require these submodules:
- `tests/6502_65C02_functional_tests` - Klaus Dormann's 6502 test suite
- `tests/integration/dp111_6502Timing` - Detailed timing tests

Initialize with: `git submodule update --init --recursive`

### Build Output

- **Web build**: Creates static files in `dist/` directory
- **Bundle size**: ~516KB JavaScript (warns about large chunks)
- **Assets**: ROMs, disc images, CSS, and JavaScript modules
- **Deployment**: Automatically deployed to S3 (bbc.xania.org) on main branch

### Electron Application

- **Entry point**: `src/app/app.js`
- **Features**: Disc loading dialogs, native menus
- **Development**: Can build but cannot interact with UI in CI environment
- **Architecture**: Uses same emulation core as web version

## Error Handling and Troubleshooting

### Common Issues

- **"Functional tests submodule missing"**: Run `git submodule update --init --recursive`
- **Node version warnings**: Upgrade to Node.js 22 (required in package.json)
- **Test timeouts**: Increase timeout values, especially for CPU tests (66+ seconds)
- **Build warnings about chunk size**: Expected behavior due to large emulation codebase

### Emulation-Specific Constraints

- **Timing accuracy**: Critical for BBC Micro compatibility
- **CPU tests**: Validate against real hardware behavior
- **Memory emulation**: Includes 6502, 65C02, and 65C12 variants
- **Peripheral emulation**: VIA chips, FDC, sound, video, serial, etc.

### CI/CD Pipeline

GitHub Actions workflow (`.github/workflows/test-and-deploy.yml`):

1. Unit and integration tests on Ubuntu 24.04
2. CPU accuracy tests (separate job)
3. Production build and S3 deployment
4. Uses Node.js 22, caches npm dependencies

Always ensure local validation matches CI requirements before pushing.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Test Commands

- `npm start` - Start development server
- `npm run build` - Build production version
- `npm run lint` - Run ESLint
- `npm run lint-fix` - Run ESLint with auto-fix
- `npm run format` - Run Prettier
- `npm run test` - Run all tests
- `npm run test:unit` - Run unit tests
- `npm run test:integration` - Run integration tests
- `vitest run tests/unit/test-gzip.js` - Run a single test file

### Code Coverage

- `npm run test:coverage` - Run unit tests with coverage
- `npm run test:coverage:utils` - Run just utils.js tests with coverage
- `npm run test:coverage:all` - Run all tests with coverage
- Coverage reports are generated in the `coverage` directory
- HTML report includes line-by-line coverage visualization

## Code Style Guidelines

- **Formatting**: Uses Prettier, configured in package.json
- **Linting**: ESLint with eslint-config-prettier integration
- **Modules**: ES modules with import/export syntax (type: "module")
- **JavaScript Target**: ES2020 with strict null checks
- **Error Handling**: Use try/catch with explicit error messages
- **Naming**: camelCase for variables and functions, PascalCase for classes
- **Imports**: Group by source (internal/external) with proper separation
- **Function Existence Checks**:
  - Never use `typeof x === 'function'` to check if methods exist
  - Either directly call the method or add a stub implementation
  - For optional components, use explicit object existence check (`if (this.component)`)
  - Use TODOs to mark methods that need future implementation

## Project-Specific Knowledge

### Code Architecture

- **Video Rendering**: `Video` class in video.js handles all rendering

  - Scanlines are processed by the `polltime` method
  - `blitFb` renders individual character blocks
  - End of scanlines is handled in `endOfScanline` method

- **Important Constants**:

  - Local un-exported properties should be used for shared constants
  - Local constants should be used for temporary values

- **Class Exports**:

  - Classes that need to be tested must be explicitly exported
  - Consider using named exports for all classes and functions that might be needed in tests

- **Component Testing**:

  - Each component should have its own test file in tests/unit/
  - When adding new component functionality, add corresponding tests
  - Always run tests after making changes: `npm run test:unit`

- **Pre-commit Hooks**:
  - The project uses lint-staged with ESLint
  - Watch for unused variables and ensure proper error handling
  - Run linting check before committing: `npm run lint`

### Git Workflow

- When creating branches with Claude, use the `claude/` prefix (e.g., `claude/fix-esm-import-error`)
- Always run linting and tests before committing changes
- Update issue notes with progress for long-running feature implementations

### Save State Implementation

- Save state functionality uses a component-based approach
- Each component (CPU, video, scheduler, etc.) implements saveState/loadState methods
- A central SaveState class coordinates serialization across components
- TimeTravel class provides rewind buffer functionality
- SaveStateStorage handles browser local storage integration
- Tests cover each component's ability to save and restore its state
- The load order of components is important - scheduler should be loaded before peripherals
- VIA and ACIA state is critical for proper task scheduling after loading

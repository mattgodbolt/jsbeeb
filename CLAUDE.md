# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Test Commands

- `npm start` - Start development server (IMPORTANT: Never run this command directly; ask the user to start the server as needed)
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

## Project-Specific Knowledge

### Code Architecture

- **Video Rendering**: `Video` class in video.js handles all rendering

  - Scanlines are processed by the `polltime` method
  - `blitFb` renders individual character blocks
  - End of scanlines is handled in `endOfScanline` method

- **Important Constants**:

  - Local un-exported properties should be used for shared constants
  - Local constants should be used for temporary values

- **Pre-commit Hooks**:
  - The project uses lint-staged with ESLint
  - Watch for unused variables and ensure proper error handling

### Git Workflow

- When creating branches with Claude, use the `claude/` prefix (e.g., `claude/fix-esm-import-error`)

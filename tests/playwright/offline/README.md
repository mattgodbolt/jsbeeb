# Offline stand-ins

What the e2e suite's pages are served in place of the sites they fetch from, at `<host>/<path>`
(`tests/playwright/fixtures.js`). Each file is cut down from the one published at that URL, keeping
only what the tests look at: the symbol sets keep the names near the addresses the debugger test
goes to, under their published title, source, licence and notice, and each manifest keeps two
entries.

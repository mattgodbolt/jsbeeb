/**
 * Returns the command-line arguments the user actually passed to jsbeeb, with
 * the Electron binary path(s) and known runtime-injected flags stripped.
 *
 * @param {string[]} [argv=process.argv] Full argv array.
 * @param {boolean} [defaultApp=process.defaultApp]
 *   True when running under `electron .` (dev); Electron sets it only then,
 *   whatever the binary is called.
 * @returns {string[]}
 */
export function getArguments(argv = process.argv, defaultApp = process.defaultApp) {
    // In a packaged Electron app argv is [appBinary, ...userArgs]; when running
    // under `electron .` (dev) it is [electronBinary, appPath, ...userArgs].
    const args = defaultApp ? argv.slice(2) : argv.slice(1);

    // Filter out Chrome switches that appear in argv. The snap wrapper adds
    // --no-sandbox for compatibility, and --disable-gpu might be useful. We
    // don't support snap any more, but these seemed useful to leave.
    const ignoredChromeFlags = ["--no-sandbox", "--disable-gpu"];
    return args.filter((arg) => !ignoredChromeFlags.includes(arg));
}

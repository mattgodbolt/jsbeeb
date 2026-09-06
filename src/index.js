/**
 * What jsbeeb offers a program that is not the web page: a machine to drive
 * headless, the session the MCP server wraps around it, the models, and the
 * pieces that describe and feed a machine. Electron starts from src/app/app.js
 * through package.json's main; the page starts from src/main.js.
 */
export { MachineSession } from "./machine-session.js";
export { TestMachine } from "./test-machine.js";
export { allModels, findModel } from "./models.js";
export { machineSpec, nullIo } from "./machine-spec.js";
export { MediaResolver } from "./media-resolver.js";

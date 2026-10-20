import { MachineSession } from "../../src/machine-session.js";

export const CyclesPerSecond = 2000000;
export const BootTimeout = 60000;

export async function bootedSession(modelName = "B-DFS1.2", opts) {
    const session = new MachineSession(modelName, opts);
    await session.initialise();
    await session.boot(30);
    return session;
}

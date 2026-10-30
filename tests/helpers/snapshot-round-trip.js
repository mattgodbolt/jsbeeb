import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";

/**
 * Drives a device away from its power-on state, snapshots it, restores that into a freshly made
 * device and expects the restored device to snapshot the same. This shows that what a snapshot
 * stores comes back and that restoring the device afterwards leaves the snapshot alone; it cannot
 * show that the snapshot stores everything that matters.
 *
 * @param {() => object | Promise<object>} makeDevice builds a device in its power-on state
 * @param {(device: object) => void | Promise<void>} driveIntoState moves it through its public interface
 */
export async function expectSnapshotRoundTrips(makeDevice, driveIntoState) {
    const device = await makeDevice();
    const powerOn = device.snapshotState();
    const powerOnCopy = structuredClone(powerOn);
    await driveIntoState(device);
    const saved = device.snapshotState();
    expect(isDeepStrictEqual(saved, powerOn), "driving left the device as it powered on").toBe(false);
    const savedCopy = structuredClone(saved);
    device.restoreState(powerOnCopy);
    expect(isDeepStrictEqual(structuredClone(saved), savedCopy), "the snapshot shares state with the device").toBe(
        true,
    );

    const restored = await makeDevice();
    restored.restoreState(saved);
    expect(restored.snapshotState()).toStrictEqual(saved);
}

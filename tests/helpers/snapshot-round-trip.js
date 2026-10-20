import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";

/**
 * Drives a device away from its power-on state, snapshots it, restores that into a freshly made
 * device and expects the restored device to snapshot the same. This shows that what a snapshot
 * stores comes back; it cannot show that the snapshot stores everything that matters.
 *
 * @param {() => object | Promise<object>} makeDevice builds a device in its power-on state
 * @param {(device: object) => void | Promise<void>} driveIntoState moves it through its public interface
 */
export async function expectSnapshotRoundTrips(makeDevice, driveIntoState) {
    const device = await makeDevice();
    const powerOn = device.snapshotState();
    await driveIntoState(device);
    const saved = device.snapshotState();
    expect(isDeepStrictEqual(saved, powerOn), "driving left the device as it powered on").toBe(false);

    const restored = await makeDevice();
    restored.restoreState(saved);
    const resaved = restored.snapshotState();
    // Vitest compares a typed array element by element, half a second for a machine's RAM; it only runs to show a diff.
    if (!isDeepStrictEqual(resaved, saved)) expect(resaved).toStrictEqual(saved);
}

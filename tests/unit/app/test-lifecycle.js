import { describe, expect, it, vi } from "vitest";

import { quitAfterLastWindowCloses } from "../../../src/app/lifecycle.js";

describe("quitting after the last window closes", () => {
    it("quits after pending operations settle", async () => {
        const quit = vi.fn();
        const pending = Promise.resolve();

        await quitAfterLastWindowCloses({ pendingOperations: new Set([pending]), getWindowCount: () => 0, quit });

        expect(quit).toHaveBeenCalledOnce();
    });

    it("does not quit if the app is reactivated while operations settle", async () => {
        const quit = vi.fn();
        let finishOperation;
        const pending = new Promise((resolve) => {
            finishOperation = resolve;
        });
        let windowCount = 0;

        const quitting = quitAfterLastWindowCloses({
            pendingOperations: new Set([pending]),
            getWindowCount: () => windowCount,
            quit,
        });
        windowCount = 1;
        finishOperation();
        await quitting;

        expect(quit).not.toHaveBeenCalled();
    });
});

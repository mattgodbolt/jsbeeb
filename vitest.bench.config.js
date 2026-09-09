import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Vite's module runner reaches an imported binding through a getter, and the emulator
        // crosses modules once an instruction: a fifth of the speed.
        experimental: { viteModuleRunner: false },
    },
});

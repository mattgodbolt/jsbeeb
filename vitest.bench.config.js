import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Native imports: under the module runner this benchmark reads a fifth low, and four
        // fifths of that is Vitest's export-getter counter, which runs only while benchmarking.
        experimental: { viteModuleRunner: false },
        // Each file is its own process, for one model's type feedback; run side by side they share the CPU.
        fileParallelism: false,
    },
});

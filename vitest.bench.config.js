import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Native imports: under the module runner this benchmark reads a fifth low, and four
        // fifths of that is Vitest's export-getter counter, which runs only while benchmarking.
        experimental: { viteModuleRunner: false },
    },
});

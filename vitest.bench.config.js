import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Vitest's module runner reaches imported bindings through getters, which costs this
        // benchmark a fifth of its speed.
        experimental: { viteModuleRunner: false },
    },
});

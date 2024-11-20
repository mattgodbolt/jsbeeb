import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [...configDefaults.include, "tests/unit/**/*.js", "tests/integration/**/*.js"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/js/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/js/lib/**/*.ts"],
      // type-only module: no runtime statements to instrument
      exclude: ["src/js/lib/bpmn-types.ts"],
    },
  },
});

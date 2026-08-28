import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Browser-side editor modules need a DOM; the agent/studio modules are
    // environment-agnostic and run fine under jsdom too, so one project covers both.
    environment: "jsdom",
    include: ["src/**/*.test.ts", "workflows/**/*.test.ts", "element_templates/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/js/lib/**/*.ts", "src/agent/**/*.ts", "src/studio/**/*.ts"],
      // type-only modules: no runtime statements to instrument
      exclude: ["src/js/lib/bpmn-types.ts", "src/**/types.ts"],
    },
  },
});

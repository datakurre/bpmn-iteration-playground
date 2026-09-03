import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Browser-side editor modules need a DOM; the agent/studio modules are
    // environment-agnostic and run fine under jsdom too, so one project covers both.
    environment: "jsdom",
    include: ["src/**/*.test.ts", "workflows/**/*.test.ts", "element_templates/**/*.test.ts"],
    // src/cli/main.test.ts spawns a full Node subprocess (dist/graph-agent.js)
    // per assertion -- reliably north of vitest's 5s default under any load.
    // Set globally so a new spawn-based test can't be added without one by
    // accident (issue #95); the per-test `}, 20000)` overrides this replaced
    // are gone.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/js/lib/**/*.ts", "src/agent/**/*.ts", "src/studio/**/*.ts"],
      // type-only modules: no runtime statements to instrument
      exclude: ["src/js/lib/bpmn-types.ts", "src/**/types.ts"],
    },
  },
});

import { defineConfig } from "vitest/config";

export const coverageThresholds = { lines: 80, branches: 80, functions: 80, statements: 80 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "tests/harness/**/*.test.ts", "{apps,packages,tools}/*/src/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["{apps,packages,tools}/*/src/**/*.ts"],
      // cli.ts is exercised as a subprocess in tests/harness, which v8 coverage does not see
      exclude: ["**/*.test.ts", "tools/docs-check/src/cli.ts"],
      thresholds: coverageThresholds,
    },
  },
});

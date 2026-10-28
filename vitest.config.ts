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
        // Real Linken Sphere: local only, run by `pnpm test:ls`, never in CI
        test: {
          name: "ls",
          include: ["tests/ls/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts", "tests/recovery/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      // Unit and integration projects together. The web app is covered by e2e;
      // entry points (main.ts, *cli.ts) run as subprocesses, which v8 coverage does not see.
      include: ["{apps,packages,tools}/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "apps/web/**", "**/main.ts", "**/*cli.ts"],
      thresholds: coverageThresholds,
    },
  },
});

import { defineConfig } from "vitest/config";
import { coverageThresholds } from "../../../../vitest.config.ts";

// Fault injection for the coverage gate: same thresholds as the repository, half-covered code.
export default defineConfig({
  test: {
    include: ["*.check.ts"],
    coverage: { provider: "v8", include: ["math.ts"], thresholds: coverageThresholds, reporter: ["text"] },
  },
});

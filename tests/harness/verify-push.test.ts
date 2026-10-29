import { describe, expect, test } from "vitest";
import { pick } from "../../tools/verify-push/src/pick.ts";

describe("pre-push picks the tests a change needs", () => {
  const tests = ["tests/integration/pipeline.test.ts", "tests/integration/ls-clicker.test.ts", "tests/e2e/pipeline.spec.ts", "tests/e2e/agent-menu.spec.ts", "tests/e2e/agents.spec.ts"];

  test("a changed file brings the tests named like it; a changed test runs itself", () => {
    expect(pick(["apps/web/src/pages/pipeline-table.tsx"], tests)).toEqual(["tests/integration/pipeline.test.ts", "tests/e2e/pipeline.spec.ts"]);
    expect(pick(["apps/control-plane/src/ls-clicker.ts", "apps/mac-agent/src/ls-clicker.ts"], tests)).toEqual(["tests/integration/ls-clicker.test.ts"]);
    expect(pick(["tests/e2e/agent-menu.spec.ts"], tests)).toEqual(["tests/e2e/agent-menu.spec.ts"]);
  });

  test("a file no test is named after brings none", () => {
    expect(pick(["apps/web/src/components/data-table.tsx", "README.md"], tests)).toEqual([]);
  });
});

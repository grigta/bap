import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { type BrowserProvider } from "@bap/browser-adapters";
import { CheckpointStore, InputValidationError, renderReport, runScenario } from "@bap/engine";
import { SDK_VERSION, ScenarioDefinitionError, defineScenario } from "@bap/scenario-sdk";

const base = { id: "demo", version: "1.0.0", inputSchema: z.object({ n: z.number() }), autoResume: false, initialState: () => ({}) };
const noop = async () => {};

describe("defineScenario", () => {
  test("[REQ-RUN-006] a mutating step without verify is rejected at registration", () => {
    const steps = [{ id: "pay", mutating: true, run: noop }];
    // @ts-expect-error: the type system rejects a mutating step without verify
    expect(() => defineScenario({ ...base, steps })).toThrow(new ScenarioDefinitionError("scenario demo: mutating step pay has no verify"));
  });

  test("[REQ-RUN-006] a mutating step with verify is accepted and stamped with the SDK version", () => {
    const scenario = defineScenario({ ...base, steps: [{ id: "pay", mutating: true, run: noop, verify: async () => true }] });
    expect(scenario.sdkVersion).toBe(SDK_VERSION);
    expect(Object.isFrozen(scenario)).toBe(true);
  });

  test.each([
    [{ id: "Bad Id" }, /kebab-case/],
    [{ version: "1.0" }, /not semver/],
    [{ steps: [] }, /has no steps/],
    [{ steps: [{ id: "a", run: noop }, { id: "a", run: noop }] }, /duplicate step id a/],
  ])("rejects an invalid definition %#", (patch, message) => {
    expect(() => defineScenario({ ...base, steps: [{ id: "a", run: noop }], ...patch } as never)).toThrow(message);
  });
});

describe("runScenario", () => {
  test("[REQ-RUN-010] invalid input is rejected before any browser session is opened", async () => {
    const openSession = vi.fn();
    const provider: BrowserProvider = { isAvailable: async () => true, listProfiles: async () => [], profileState: async () => "idle", openSession };
    const scenario = defineScenario({ ...base, steps: [{ id: "a", run: noop }] });
    const checkpoints = new CheckpointStore(":memory:");
    await expect(
      runScenario({ scenario, input: { n: "x" }, provider, profileId: "p", runId: "r", agentId: "a", artifactsDir: "/nonexistent", checkpoints }),
    ).rejects.toThrow(InputValidationError);
    expect(openSession).not.toHaveBeenCalled();
  });
});

test("report escapes step errors and marks statuses", () => {
  const html = renderReport({
    runId: "r1",
    scenarioId: "demo",
    scenarioVersion: "1.0.0",
    profileId: "p",
    status: "NEEDS_REVIEW",
    startedAt: "t0",
    finishedAt: "t1",
    reportPath: "x",
    steps: [
      { id: "a", mutating: false, status: "passed", startedAt: "t", durationMs: 5, screenshot: "01-a.png" },
      { id: "pay", mutating: true, status: "unverified", startedAt: "t", durationMs: 7, error: "<script>x</script>" },
    ],
  });
  expect(html).toContain('<span class="status NEEDS_REVIEW">NEEDS_REVIEW</span>');
  expect(html).toContain('<li class="unverified">');
  expect(html).toContain("&#60;script&#62;x&#60;/script&#62;");
  expect(html).toContain('<img src="01-a.png"');
});

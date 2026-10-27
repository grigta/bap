import { defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";

/** Waits on /slow: with a small run timeout it must fail with TIMEOUT. */
export default defineScenario({
  id: "slow-page",
  version: "1.0.0",
  inputSchema: z.object({ baseUrl: z.url(), ms: z.number().int() }),
  autoResume: true,
  initialState: () => ({}),
  steps: [{ id: "open-slow", run: async ({ page, input }) => void (await page.goto(`${input.baseUrl}/slow?ms=${input.ms}`)) }],
});

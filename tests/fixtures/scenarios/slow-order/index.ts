import { defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";

/** A mutating step that outlives the run timeout and cannot prove its effect: NEEDS_REVIEW, no retry. */
export default defineScenario({
  id: "slow-order",
  version: "1.0.0",
  inputSchema: z.object({ baseUrl: z.url() }),
  autoResume: false,
  initialState: () => ({}),
  steps: [
    {
      id: "place-slow-order",
      mutating: true,
      run: async ({ page, input }) => void (await page.goto(`${input.baseUrl}/slow?ms=5000`)),
      verify: async () => false,
    },
  ],
});

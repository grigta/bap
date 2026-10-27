import { defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";

/** Opens the failing page and expects content it does not have. */
export default defineScenario({
  id: "crash-page",
  version: "1.0.0",
  inputSchema: z.object({ baseUrl: z.url() }),
  autoResume: true,
  initialState: () => ({}),
  steps: [
    { id: "open-crash", run: async ({ page, input }) => void (await page.goto(`${input.baseUrl}/crash`)) },
    { id: "expect-orders", run: async ({ page }) => page.getByRole("heading", { name: "Заказы" }).waitFor({ timeout: 1000 }) },
  ],
});

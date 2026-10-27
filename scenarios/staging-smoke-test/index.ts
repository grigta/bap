import { defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";

/** Read-only walk through the test site. */
export default defineScenario({
  id: "staging-smoke-test",
  version: "1.0.0",
  inputSchema: z.object({ baseUrl: z.url() }),
  autoResume: true,
  initialState: () => ({}),
  steps: [
    {
      id: "open-home",
      run: async ({ page, input }) => {
        await page.goto(input.baseUrl);
        await page.locator("#visits").waitFor();
      },
    },
    {
      id: "open-wizard",
      run: async ({ page, input }) => {
        await page.goto(`${input.baseUrl}/wizard`);
        await page.getByRole("heading", { name: "Шаг 1 из 5: товар" }).waitFor();
      },
    },
    {
      id: "open-orders",
      run: async ({ page, input }) => {
        await page.goto(`${input.baseUrl}/orders`);
        await page.getByRole("heading", { name: "Заказы" }).waitFor();
      },
    },
  ],
});

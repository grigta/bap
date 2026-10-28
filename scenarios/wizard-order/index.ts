import { defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";

/**
 * Places one order through the 5-step wizard; step 4 changes site data.
 * Every step opens its own wizard page, so a run can resume after any checkpoint.
 * `item` must be unique per run: verify finds the order by it when the agent died before reading the order id.
 */
export default defineScenario({
  id: "wizard-order",
  version: "1.1.0",
  inputSchema: z.object({ baseUrl: z.url(), item: z.string().min(1) }),
  autoResume: false,
  initialState: (): { orderId: number | null } => ({ orderId: null }),
  steps: [
    {
      id: "choose-item",
      run: async ({ page, input }) => {
        await page.goto(`${input.baseUrl}/wizard`);
        await page.getByLabel("Товар").fill(input.item);
        await page.getByRole("button", { name: "Далее" }).click();
        await page.getByRole("heading", { name: "Шаг 2 из 5: проверка" }).waitFor();
      },
    },
    {
      id: "review",
      run: async ({ page, input }) => {
        await page.goto(`${input.baseUrl}/wizard?step=2&item=${encodeURIComponent(input.item)}`);
        await page.getByRole("button", { name: "Далее" }).click();
        await page.getByRole("heading", { name: "Шаг 3 из 5: проверка" }).waitFor();
      },
    },
    {
      id: "confirm",
      run: async ({ page, input }) => {
        await page.goto(`${input.baseUrl}/wizard?step=3&item=${encodeURIComponent(input.item)}`);
        await page.getByRole("button", { name: "Далее" }).click();
        await page.getByRole("heading", { name: "Шаг 4 из 5: оформление" }).waitFor();
      },
    },
    {
      id: "place-order",
      mutating: true,
      run: async ({ page, input, state }) => {
        await page.goto(`${input.baseUrl}/wizard?step=4&item=${encodeURIComponent(input.item)}`);
        await page.getByRole("button", { name: "Оформить заказ" }).click();
        state.orderId = Number((await page.locator("#order-id").textContent({ timeout: 30_000 }))?.replace("#", ""));
      },
      verify: async ({ page, input, state }) => {
        const res = await page.request.get(`${input.baseUrl}/api/orders`);
        if (!res.ok()) return false; // the site cannot tell: not confirmed
        const orders: { id: number; item: string }[] = await res.json();
        const mine = orders.filter((o) => o.item === input.item);
        if (state.orderId !== null) return mine.some((o) => o.id === state.orderId);
        if (mine.length !== 1) return false; // none, or more than one: ambiguous
        state.orderId = mine[0]!.id;
        return true;
      },
    },
    {
      id: "check-orders",
      run: async ({ page, input }) => {
        await page.goto(`${input.baseUrl}/orders`);
        await page.getByRole("heading", { name: "Заказы" }).waitFor();
      },
    },
  ],
});

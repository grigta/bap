import { defineScenario } from "@bap/scenario-sdk";
import { z } from "zod";

/** Places one order through the 5-step wizard; step 4 changes site data. */
export default defineScenario({
  id: "wizard-order",
  version: "1.0.0",
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
      },
    },
    {
      id: "review",
      run: async ({ page }) => {
        await page.getByRole("heading", { name: "Шаг 2 из 5: проверка" }).waitFor();
        await page.getByRole("button", { name: "Далее" }).click();
      },
    },
    {
      id: "confirm",
      run: async ({ page }) => {
        await page.getByRole("heading", { name: "Шаг 3 из 5: проверка" }).waitFor();
        await page.getByRole("button", { name: "Далее" }).click();
      },
    },
    {
      id: "place-order",
      mutating: true,
      run: async ({ page, state }) => {
        await page.getByRole("heading", { name: "Шаг 4 из 5: оформление" }).waitFor();
        await page.getByRole("button", { name: "Оформить заказ" }).click();
        state.orderId = Number((await page.locator("#order-id").textContent())?.replace("#", ""));
      },
      verify: async ({ page, input, state }) => {
        if (state.orderId === null) return false;
        const orders: { id: number; item: string }[] = await (await page.request.get(`${input.baseUrl}/api/orders`)).json();
        return orders.some((o) => o.id === state.orderId && o.item === input.item);
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

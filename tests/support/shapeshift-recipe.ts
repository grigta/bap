// A recipe for the shapeshift shop written by a person, not recorded by a model: each target is picked by its
// visible name on layout seed 1 and fingerprinted, exactly as a recording would store it.
import { captureSnapshot, fingerprintOf, templatize } from "@bap/dom-snapshot";
import type { Recipe, RecipeStep } from "@bap/recipe";
import type { Page } from "playwright-core";

export const SHOP_INPUT = {
  query: "Ноутбук",
  item: "Ноутбук Pro 15",
  name: "Анна Петрова",
  phone: "+7 900 123-45-67",
  address: "Москва, Тверская 1",
  delivery: "Курьер",
};

/** baseUrl is an input: the site runs on a different port in every test. */
export async function shapeshiftRecipe(page: Page, baseUrl: string): Promise<Recipe> {
  const input = { baseUrl, ...SHOP_INPUT };
  await page.request.post(`${baseUrl}/api/layout`, { data: { seed: 1, wording: 0 } });
  const target = async (role: string, name: string, context?: string) => {
    const snap = await captureSnapshot(page);
    await snap.dispose();
    const el = snap.page.elements.find((e) => e.visible && e.role === role && e.name === name && (!context || e.context.includes(context)));
    if (!el) throw new Error(`no ${role} “${name}” on ${page.url()}`);
    return templatize(fingerprintOf(el, snap.page), input);
  };
  const steps: RecipeStep[] = [{ id: "s01", intent: "Открыть магазин", action: "navigate", value: "{{input.baseUrl}}/", mutating: false }];
  const add = (step: Omit<RecipeStep, "id">) => steps.push({ id: `s${String(steps.length + 1).padStart(2, "0")}`, ...step });

  await page.goto(`${baseUrl}/`);
  add({ intent: "Ввести название товара в поиск", action: "fill", target: await target("searchbox", "Поиск товаров"), value: "{{input.query}}", mutating: false });
  add({ intent: "Нажать «Найти»", action: "click", target: await target("button", "Найти"), mutating: false, postcondition: { url: "q=" } });
  await page.goto(`${baseUrl}/?q=${encodeURIComponent(SHOP_INPUT.query)}`);
  add({ intent: "Положить товар в корзину", action: "click", target: await target("button", "В корзину", SHOP_INPUT.item), mutating: true, postcondition: { url: "/cart", text: "{{input.item}}" } });
  await page.request.post(`${baseUrl}/cart/add`, { form: { product: "p1" } });
  await page.goto(`${baseUrl}/cart`);
  add({ intent: "Перейти к оформлению", action: "click", target: await target("link", "Перейти к оформлению"), mutating: false, postcondition: { url: "/checkout" } });
  await page.goto(`${baseUrl}/checkout`);
  await page.frameLocator("iframe[title=Условия]").locator("input").waitFor();
  add({ intent: "Заполнить имя", action: "fill", target: await target("textbox", "Имя"), value: "{{input.name}}", mutating: false });
  add({ intent: "Заполнить телефон", action: "fill", target: await target("textbox", "Телефон"), value: "{{input.phone}}", mutating: false });
  add({ intent: "Заполнить адрес", action: "fill", target: await target("textbox", "Адрес"), value: "{{input.address}}", mutating: false });
  add({ intent: "Выбрать способ доставки", action: "select", target: await target("combobox", "Способ доставки"), value: "{{input.delivery}}", mutating: false });
  add({ intent: "Согласиться с условиями", action: "click", target: await target("checkbox", "Я согласен с условиями"), mutating: false });
  add({ intent: "Оформить заказ", action: "click", target: await target("button", "Оформить заказ"), mutating: true, postcondition: { url: "/order/", text: "оформлен" } });
  await page.request.delete(`${baseUrl}/api/orders`);
  return {
    schema: 1,
    goal: "Купить {{input.item}} с доставкой по адресу",
    startUrl: `${baseUrl}/`,
    inputs: ["baseUrl", ...Object.keys(SHOP_INPUT)].map((name) => ({ name, secret: false })),
    steps,
  };
}

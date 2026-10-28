import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Fingerprint, MASK, type PageSnapshot, act, captureSnapshot, fingerprintOf, resolve } from "@bap/dom-snapshot";
import { type LaunchedChromium, closeChromium, launchChromium } from "@bap/browser-adapters";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestSite } from "../support/test-site.ts";

let site: Awaited<ReturnType<typeof startTestSite>>;
let launched: LaunchedChromium;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  site = await startTestSite("shapeshift-site");
  launched = await launchChromium(mkdtempSync(join(tmpdir(), "bap-dom-")), true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${launched.port}`);
  page = await browser.contexts()[0]!.newPage();
});
afterAll(async () => {
  await browser?.close();
  if (launched) await closeChromium(launched);
  await site?.stop();
});

const setLayout = (layout: { seed?: number; wording?: number }) => page.request.post(`${site.url}/api/layout`, { data: layout });

/** Opens a page of the flow; the cart must hold an item for the cart and checkout pages. */
async function open(path: "/" | "/cart" | "/checkout") {
  if (path !== "/") await page.request.post(`${site.url}/cart/add`, { form: { product: "p1" } });
  await page.goto(`${site.url}${path}`);
  if (path === "/checkout") await page.frameLocator("iframe[title=Условия]").locator("input").waitFor();
}

async function snapshot(): Promise<PageSnapshot> {
  const snap = await captureSnapshot(page);
  await snap.dispose();
  return snap.page;
}

// What a person would look for on each page, and how to tell it is the right element.
const TARGETS: { page: "/" | "/cart" | "/checkout"; role: string; name: string; renamed: string; context?: string }[] = [
  { page: "/", role: "searchbox", name: "Поиск товаров", renamed: "Что ищем?" },
  { page: "/", role: "button", name: "Найти", renamed: "Искать" },
  { page: "/", role: "button", name: "В корзину", renamed: "Купить", context: "Ноутбук Pro 15" },
  { page: "/", role: "link", name: "Корзина", renamed: "Мои покупки" },
  { page: "/cart", role: "link", name: "Перейти к оформлению", renamed: "К оплате" },
  { page: "/checkout", role: "textbox", name: "Имя", renamed: "Как вас зовут" },
  { page: "/checkout", role: "textbox", name: "Телефон", renamed: "Номер для связи" },
  { page: "/checkout", role: "textbox", name: "Адрес", renamed: "Куда доставить" },
  { page: "/checkout", role: "combobox", name: "Способ доставки", renamed: "Доставка" },
  { page: "/checkout", role: "textbox", name: "Промокод", renamed: "Промокод" },
  { page: "/checkout", role: "button", name: "Применить", renamed: "Применить" },
  { page: "/checkout", role: "checkbox", name: "Я согласен с условиями", renamed: "Принимаю условия" },
  { page: "/checkout", role: "button", name: "Выбрать пункт выдачи", renamed: "Выбрать пункт выдачи" },
  { page: "/checkout", role: "button", name: "Оформить заказ", renamed: "Подтвердить покупку" },
];

const find = (snap: PageSnapshot, t: (typeof TARGETS)[number], name = t.name) =>
  snap.elements.filter((e) => e.visible && e.role === t.role && e.name === name && (!t.context || e.context.includes(t.context)));

describe("page snapshot", () => {
  test("[REQ-DOM-001] covers interactive elements of the page, a same-origin frame, a cross-origin frame and shadow trees", async () => {
    // Seeds 1 and 2 put the promo field into an open and a closed shadow root.
    for (const seed of [1, 2]) {
      await setLayout({ seed, wording: 0 });
      await open("/checkout");
      const snap = await snapshot();
      for (const t of TARGETS.filter((x) => x.page === "/checkout")) expect(find(snap, t), `${t.name} (seed ${seed})`).toHaveLength(1);
      const consent = find(snap, TARGETS.find((t) => t.role === "checkbox")!)[0]!;
      expect(consent.frame).toMatch(/^http:\/\/localhost:\d+\/consent-frame$/);
      expect(find(snap, TARGETS.find((t) => t.name === "Выбрать пункт выдачи")!)[0]!.frame).toMatch(/\/pickup-frame$/);
      expect(find(snap, TARGETS.find((t) => t.name === "Промокод")!)[0]!.shadowHost).toBe("promo-code");
      expect(find(snap, TARGETS.find((t) => t.name === "Способ доставки")!)[0]!.options).toEqual(expect.arrayContaining(["Курьер", "Самовывоз", "Почта"]));
      // Refs are e1…eN, unique, in document order.
      expect(snap.elements.map((e) => e.ref)).toEqual(snap.elements.map((_, i) => `e${i + 1}`));
      // Positions are in the top document: the frame's checkbox lies inside its <iframe>.
      expect(consent.rect.x).toBeGreaterThan(20);
      expect(snap.text).toContain("Оформление");
    }
  });

  test("[REQ-DOM-006] the resolver finds the same element on 20 other layouts and never picks a wrong one after a redesign", async () => {
    await setLayout({ seed: 1, wording: 0 });
    const recorded = new Map<string, Fingerprint>();
    for (const path of ["/", "/cart", "/checkout"] as const) {
      await open(path);
      const snap = await snapshot();
      for (const t of TARGETS.filter((x) => x.page === path)) recorded.set(t.name, fingerprintOf(find(snap, t)[0]!, snap));
    }

    const scores: number[] = [];
    for (let seed = 2; seed <= 21; seed++) {
      await setLayout({ seed, wording: 0 });
      for (const path of ["/", "/cart", "/checkout"] as const) {
        await open(path);
        const snap = await snapshot();
        for (const t of TARGETS.filter((x) => x.page === path)) {
          const result = resolve(recorded.get(t.name)!, snap);
          expect(result.kind, `${t.name} on seed ${seed}`).toBe("found");
          if (result.kind !== "found") continue;
          expect(find(snap, t).map((e) => e.ref), `${t.name} on seed ${seed}`).toEqual([result.ref]);
          scores.push(result.score);
        }
      }
    }
    expect(scores).toHaveLength(20 * TARGETS.length);

    // Renamed elements: either not found (healing takes over) or found correctly, never another element.
    await setLayout({ seed: 5, wording: 1 });
    let missing = 0;
    for (const path of ["/", "/cart", "/checkout"] as const) {
      await open(path);
      const snap = await snapshot();
      for (const t of TARGETS.filter((x) => x.page === path)) {
        const result = resolve(recorded.get(t.name)!, snap);
        if (result.kind === "found") expect(find(snap, t, t.renamed).map((e) => e.ref), `${t.name} → ${t.renamed}`).toEqual([result.ref]);
        else missing++;
      }
    }
    expect(missing).toBeGreaterThanOrEqual(5);
  });

  test("[REQ-DOM-001] acts through mouse and keyboard on fields, shadow DOM, a select and a cross-origin checkbox: the order goes through", async () => {
    await page.request.delete(`${site.url}/api/orders`);
    await setLayout({ seed: 2, wording: 0 }); // closed shadow root
    await open("/checkout");
    const values: Record<string, string> = { Имя: "Анна", Телефон: "+7 900 000-00-00", Адрес: "Москва, Тверская 1", Промокод: "SALE10" };
    for (const t of TARGETS.filter((x) => x.page === "/checkout")) {
      const snap = await captureSnapshot(page);
      const el = find(snap.page, t)[0]!;
      const handle = snap.handles.get(el.ref)!;
      if (values[t.name]) await act(page, handle, { kind: "fill", value: values[t.name]! });
      else if (t.role === "combobox") await act(page, handle, { kind: "select", value: "Курьер" });
      else if (t.name !== "Оформить заказ") await act(page, handle, { kind: "click" });
      await snap.dispose();
    }
    const before = await snapshot();
    expect(before.text).toContain("Промокод применён"); // text inside the closed shadow root
    expect(before.text).toContain("Пункт выбран"); // text inside the same-origin frame
    expect(before.elements.find((e) => e.role === "checkbox")!.states).toContain("checked");

    const snap = await captureSnapshot(page);
    await Promise.all([page.waitForURL(/\/order\/\d+$/), act(page, snap.handles.get(find(snap.page, TARGETS.at(-1)!)[0]!.ref)!, { kind: "click" })]);
    await snap.dispose();
    const orders = await (await page.request.get(`${site.url}/api/orders`)).json();
    expect(orders).toEqual([expect.objectContaining({ name: "Анна", phone: "+7 900 000-00-00", address: "Москва, Тверская 1", delivery: "Курьер", promo: "SALE10", items: ["p1"] })]);
  });

  test("[REQ-DOM-002] snapshot, search and actions add no globals to the page's main world and do not change the DOM", async () => {
    await setLayout({ seed: 3, wording: 0 });
    await open("/checkout");
    await page.evaluate(() => {
      const w = window as unknown as { __mutations: number };
      w.__mutations = 0;
      new MutationObserver((list) => (w.__mutations += list.length)).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const globals = () => page.evaluate(() => Object.getOwnPropertyNames(window).sort());
    const baseline = await globals();

    const snap = await captureSnapshot(page);
    const target = find(snap.page, TARGETS.find((t) => t.role === "combobox")!)[0]!;
    expect(resolve(fingerprintOf(target, snap.page), snap.page).kind).toBe("found");
    expect(await page.evaluate(() => (window as unknown as { __mutations: number }).__mutations)).toBe(0);
    // The select is set in an isolated world: the page sees the change event, not a new global.
    await act(page, snap.handles.get(target.ref)!, { kind: "select", value: "Почта" });
    await snap.dispose();
    expect(await globals()).toEqual(baseline);
  });

  test("[REQ-DOM-003] password fields and secret values never appear in a snapshot", async () => {
    await page.setContent(`<form><label>Логин <input name="login" value="anna"></label><label>Пароль <input type="password" name="password" value="hunter2-secret"></label>
      <label>Карта <input name="card" value="4111 1111 1111 1111"></label><p>Ваша карта 4111 1111 1111 1111</p></form>`);
    const snap = await captureSnapshot(page, { secrets: ["4111 1111 1111 1111"] });
    await snap.dispose();
    const json = JSON.stringify(snap.page);
    expect(json).not.toContain("hunter2-secret");
    expect(json).not.toContain("4111 1111 1111 1111");
    expect(snap.page.elements.find((e) => e.name === "Пароль")!.value).toBe(MASK);
    expect(snap.page.elements.find((e) => e.name === "Логин")!.value).toBe("anna");
    expect(snap.page.text).toContain(`Ваша карта ${MASK}`);
  });
});

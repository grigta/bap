// S13: every kind of node and control from the DOM coverage table, on one page (tests/fixtures/shapeshift-site/zoo.html).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LaunchedChromium, LocalChromiumProvider, closeChromium, launchChromium } from "@bap/browser-adapters";
import { type ElementAction, type PageSnapshot, ActionError, act, captureSnapshot, fingerprintOf, resolve, serializeSnapshot } from "@bap/dom-snapshot";
import { CheckpointStore, runScenario } from "@bap/engine";
import { recipeScenario } from "@bap/recipe";
import { type Browser, type Page, chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startTestSite } from "../support/test-site.ts";

let site: Awaited<ReturnType<typeof startTestSite>>;
let launched: LaunchedChromium;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  site = await startTestSite("shapeshift-site");
  launched = await launchChromium(mkdtempSync(join(tmpdir(), "bap-zoo-")), true);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${launched.port}`);
  page = await browser.contexts()[0]!.newPage();
  await page.setViewportSize({ width: 1200, height: 800 });
});
afterAll(async () => {
  await browser?.close();
  if (launched) await closeChromium(launched);
  await site?.stop();
});

const openZoo = () => page.goto(`${site.url}/zoo`);
const log = async () => (await page.locator("#log").textContent())?.trim();
async function look(): Promise<PageSnapshot> {
  const snap = await captureSnapshot(page);
  await snap.dispose();
  return snap.page;
}
/** Acts on the visible element with this role and name, the way a replayed step does. */
async function on(role: string, name: string, action: ElementAction = { kind: "click" }, context?: string) {
  const snap = await captureSnapshot(page);
  try {
    const el = snap.page.elements.find((e) => e.visible && e.role === role && e.name === name && (!context || e.context.includes(context)));
    if (!el) throw new Error(`no visible ${role} “${name}”`);
    await act(page, snap.handles.get(el.ref)!, action);
  } finally {
    await snap.dispose();
  }
}

describe("DOM coverage (zoo)", () => {
  test("[REQ-DOM-016][REQ-DOM-017] the snapshot sees pseudo-element text, icons, disclosure widgets, every input type, tables, slots and srcdoc frames, and nothing inert or hidden", async () => {
    await openZoo();
    const snap = await look();
    if (process.env.BAP_EVIDENCE) {
      const dir = join(import.meta.dirname, "../../docs/evidence/S13");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "zoo-snapshot.txt"), serializeSnapshot(snap) + "\n");
      await page.screenshot({ path: join(dir, "zoo.png"), fullPage: true });
    }
    const has = (role: string, name: string) => snap.elements.some((e) => e.visible && e.interactive && e.role === role && e.name === name);
    expect(has("button", "Удалить")).toBe(true); // ::before
    expect(has("link", "Далее →")).toBe(true); // ::after
    expect(has("button", "Корзина")).toBe(true); // clickable icon: SVG <title>
    expect(has("button", "Закрыть")).toBe(true); // SVG role=button
    expect(snap.elements.some((e) => e.name === "Подробнее" && e.interactive)).toBe(true); // <summary>
    for (const [role, name] of [["textbox", "Почта"], ["textbox", "Телефон"], ["textbox", "Сайт"], ["spinbutton", "Количество"], ["slider", "Громкость"], ["checkbox", "Рассылка"], ["radio", "Картой"], ["combobox", "Город"], ["textbox", "Отзыв"], ["textbox", "Заметка"], ["button", "Отправить картинкой"], ["button", "Файл"]] as const)
      expect(has(role, name), `${role} ${name}`).toBe(true);
    expect(snap.elements.some((e) => e.name === "Дата" && e.interactive && e.tag === "input")).toBe(true);
    expect(snap.elements.find((e) => e.name === "Недоступно")?.states).toContain("disabled");
    expect(snap.elements.filter((e) => e.role === "button" && e.name === "Изменить").map((e) => e.context)).toEqual(["Чайник Изменить", "Тостер Изменить"]);
    expect(has("link", "На главную")).toBe(true); // <img alt> inside a link
    expect(snap.elements.find((e) => e.name === "Кнопка в слоте")?.shadowHost).toBe("x-card");
    expect(snap.elements.find((e) => e.name === "Кнопка во фрейме")?.frame).toBe("about:srcdoc");
    // Not usable or not shown: inert, <template>, comments, hidden inputs, closed <dialog> and popover.
    const inert = snap.elements.find((e) => e.text === "Неактивная кнопка" || e.name === "Неактивная кнопка");
    expect(inert && !inert.interactive && inert.states.includes("disabled")).toBe(true);
    expect(JSON.stringify(snap)).not.toMatch(/Шаблон не виден|комментарий не виден|hidden-value/);
    expect(has("button", "Сохранить") || has("button", "Пункт меню")).toBe(false);
  });

  test("[REQ-DOM-018] clicks open icons, disclosure widgets, dialogs and popovers; fields of every kind take values", async () => {
    await openZoo();
    await on("button", "Корзина");
    expect(await log()).toBe("корзина svg");
    await on("button", "Удалить");
    expect(await log()).toBe("удалено");
    await on("DisclosureTriangle", "Подробнее");
    await on("button", "Кнопка внутри");
    expect(await log()).toBe("скрытая кнопка");
    await on("button", "Открыть окно");
    await on("textbox", "Название", { kind: "fill", value: "Черновик" });
    await on("button", "Сохранить");
    expect(await log()).toBe("сохранено: Черновик");
    await on("button", "Меню");
    await on("button", "Пункт меню");
    expect(await log()).toBe("пункт меню");
    await on("slider", "Громкость", { kind: "fill", value: "7" });
    expect(await log()).toBe("громкость 7");
    const date = (await look()).elements.find((e) => e.name === "Дата" && e.tag === "input")!;
    await on(date.role, "Дата", { kind: "fill", value: "2026-10-28" });
    expect(await log()).toBe("дата 2026-10-28");
    await on("checkbox", "Рассылка");
    expect(await log()).toBe("рассылка true");
    await on("radio", "Наличными");
    expect(await log()).toBe("оплата наличными");
    await on("textbox", "Заметка", { kind: "fill", value: "позвонить" });
    expect(await log()).toBe("заметка позвонить");
    const file = join(mkdtempSync(join(tmpdir(), "bap-upload-")), "договор.txt");
    writeFileSync(file, "текст");
    await on("button", "Файл", { kind: "upload", files: [file] });
    expect(await log()).toBe("файл договор.txt");
    await expect(on("button", "Файл", { kind: "upload", files: ["/nowhere/x.pdf"] })).rejects.toThrow(/no such file on this Mac/);
    await on("button", "Изменить", { kind: "click" }, "Тостер");
    expect(await log()).toBe("изменить тостер");
    await on("button", "Кнопка в слоте");
    expect(await log()).toBe("из слота");
    await on("button", "Кнопка во фрейме");
    expect(await log()).toBe("кнопка во фрейме");
  });

  test("[REQ-DOM-018] hover opens a menu, double and right clicks reach their handlers", async () => {
    await openZoo();
    expect((await look()).elements.find((e) => e.text === "Ноутбуки")?.visible).toBe(false);
    const menu = (await look()).elements.find((e) => e.text === "Каталог")!;
    const snap = await captureSnapshot(page);
    await act(page, snap.handles.get(menu.ref)!, { kind: "hover" });
    await snap.dispose();
    await on("link", "Ноутбуки");
    expect(await log()).toBe("ноутбуки");
    for (const [text, kind, expected] of [["Дважды щёлкните, чтобы переименовать", "dblclick", "переименовать"], ["Правый щелчок здесь", "rightclick", "контекстное меню"]] as const) {
      const s = await captureSnapshot(page);
      await act(page, s.handles.get(s.page.elements.find((e) => e.text === text)!.ref)!, { kind });
      await s.dispose();
      expect(await log()).toBe(expected);
    }
  });

  test("[REQ-DOM-018] an element under a cookie banner is not clicked through; after the banner is accepted it is", async () => {
    await openZoo();
    await expect(on("button", "Купить под баннером")).rejects.toThrow(ActionError);
    await expect(on("button", "Купить под баннером")).rejects.toThrow(/covered by <div> “Мы используем cookies Принять”$/);
    expect(await log()).toBe("нет");
    await on("button", "Принять");
    await on("button", "Купить под баннером");
    expect(await log()).toBe("под баннером");
  });

  test("[REQ-DOM-018] a step finds its target further down a virtualized list by scrolling, as a person would", async () => {
    await openZoo();
    // Only rows in view exist: "Товар 87" is not in the DOM yet.
    const first = await look();
    expect(first.elements.some((e) => e.context.includes("Товар 87"))).toBe(false);
    const row = first.elements.find((e) => e.name === "Выбрать" && e.context === "Товар 1 Выбрать")!;
    const target = { ...fingerprintOf(row, first), context: "Товар 87 Выбрать", position: { x: 0, y: 0 } };
    expect(resolve(target, first).kind).not.toBe("found");
    const provider = new LocalChromiumProvider({ profilesDir: mkdtempSync(join(tmpdir(), "bap-zoo-profiles-")) });
    provider.createProfile("z");
    const scenario = recipeScenario({
      id: "zoo-feed",
      version: "1.0.0",
      recipe: {
        schema: 1,
        goal: "Выбрать товар 87",
        startUrl: `${site.url}/zoo`,
        inputs: [],
        steps: [
          { id: "s01", intent: "Открыть зоопарк", action: "navigate", value: `${site.url}/zoo`, mutating: false },
          { id: "s02", intent: "Выбрать товар 87", action: "click", target, mutating: false, postcondition: { text: "выбран товар 87" } },
        ],
      },
    });
    const result = await runScenario({ scenario, input: {}, provider, profileId: "z", runId: crypto.randomUUID(), agentId: "zoo", artifactsDir: mkdtempSync(join(tmpdir(), "bap-zoo-run-")), checkpoints: new CheckpointStore(":memory:"), timeoutMs: 60_000 });
    expect(result.status, result.errorMessage).toBe("SUCCEEDED");
    expect(result.steps[1]).toMatchObject({ resolution: "found" });
  });
});

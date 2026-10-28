import { describe, expect, test } from "vitest";
import { fingerprintOf, pageHasText, renderFingerprint, renderTemplate, resolve, similarity, templatize } from "./fingerprint.ts";
import { serializeSnapshot } from "./serialize.ts";
import type { PageSnapshot, SnapshotElement } from "./snapshot.ts";

const el = (ref: string, over: Partial<SnapshotElement> = {}): SnapshotElement => ({
  ref,
  role: "button",
  name: "В корзину",
  tag: "button",
  text: "В корзину",
  attrs: {},
  states: [],
  visible: true,
  interactive: true,
  rect: { x: 10, y: 10, width: 80, height: 20 },
  label: "",
  context: "",
  path: ["main", "article"],
  frame: "",
  ...over,
});
const page = (elements: SnapshotElement[]): PageSnapshot => ({ url: "http://shop/", title: "Каталог", viewport: { width: 1000, height: 800 }, elements, text: "Каталог Ноутбук" });

describe("fingerprint resolver", () => {
  test("[REQ-DOM-006] similarity compares words, ignoring case and punctuation", () => {
    expect(similarity("Корзина (2)", "корзина")).toBeCloseTo(2 / 3);
    expect(similarity("Оформить заказ", "Подтвердить покупку")).toBe(0);
    expect(similarity("", "")).toBe(0);
    expect(similarity("a", "a")).toBe(1);
  });

  test("[REQ-DOM-015] word forms of the same words are similar; opposite actions sharing a root are not", () => {
    const similar = [
      ["Оформить заказ", "Оформление заказа"],
      ["Подтвердить", "Подтверждение"],
      ["Отправить", "Отправка"],
      ["Удалить", "Удаление"],
      ["Способ доставки", "Доставка"],
      ["В корзину", "В корзинку"],
      ["Я согласен с условиями", "Я согласна с условиями"],
    ];
    for (const [a, b] of similar) expect(similarity(a!, b!), `${a} ≈ ${b}`).toBeGreaterThan(0.5);
    const opposite = [
      ["Войти", "Выйти"],
      ["Login", "Logout"],
      ["Подписаться", "Отписаться"],
      ["Включить", "Выключить"],
      ["Enable", "Disable"],
      ["Subscribe", "Unsubscribe"],
      ["Открыть", "Закрыть"],
      ["Удалить", "Добавить"],
      ["Оформить заказ", "Подтвердить покупку"],
    ];
    for (const [a, b] of opposite) expect(similarity(a!, b!), `${a} ≠ ${b}`).toBe(0);
  });

  test("[REQ-DOM-006] one candidate above the threshold is found; a renamed element is missing, not replaced", () => {
    const target = el("e1", { context: "Ноутбук Pro 15 1999 ₽ В корзину" });
    const fp = fingerprintOf(target, page([target]));
    expect(resolve(fp, page([el("e7", { context: "Ноутбук Pro 15 1999 ₽ В корзину", tag: "div" })]))).toMatchObject({ kind: "found", ref: "e7" });
    expect(resolve(fp, page([el("e2", { name: "Купить", text: "Купить" })]))).toMatchObject({ kind: "missing" });
    expect(resolve(fp, page([el("e3", { visible: false })]))).toEqual({ kind: "missing", best: null });
    expect(resolve(fp, page([el("e4", { interactive: false, role: "text" })]))).toEqual({ kind: "missing", best: null });
  });

  test("[REQ-DOM-006] identical buttons are told apart by their container text; without it the match is ambiguous", () => {
    const target = el("e1", { context: "Ноутбук Pro 15 1999 ₽ В корзину" });
    const fp = fingerprintOf(target, page([target]));
    const cards = page([el("e5", { context: "Мышь беспроводная 29 ₽ В корзину" }), el("e6", { context: "Ноутбук Pro 15 1999 ₽ В корзину" })]);
    expect(resolve(fp, cards)).toMatchObject({ kind: "found", ref: "e6" });
    const twins = page([el("e5"), el("e6")]);
    expect(resolve(fingerprintOf(el("e1"), twins), twins)).toMatchObject({ kind: "ambiguous", candidates: [{ ref: "e5" }, { ref: "e6" }] });
  });

  test("[REQ-DOM-005] input values in a fingerprint become templates and render back for another input", () => {
    const fp = fingerprintOf(el("e1", { role: "link", name: "Ноутбук Pro 15", text: "Ноутбук Pro 15", attrs: { href: "/p/1?ref=x", title: "Ноутбук Pro 15" } }), page([]));
    expect(fp.attrs.href).toBe("/p/1");
    const t = templatize(fp, { item: "Ноутбук Pro 15", qty: 1, x: "a" });
    expect(t.name).toBe("{{input.item}}");
    expect(t.attrs.title).toBe("{{input.item}}");
    expect(renderFingerprint(t, { item: "Мышь" }).name).toBe("Мышь");
    expect(renderTemplate("{{ input.qty }} шт, {{input.none}}", { qty: 2 })).toBe("2 шт, ");
  });

  test("[REQ-DOM-006] text postconditions ignore case and spacing", () => {
    expect(pageHasText(page([]), "каталог   ноутбук")).toBe(true);
    expect(pageHasText(page([]), "Заказ")).toBe(false);
    expect(pageHasText(page([el("e1", { name: "Cart, 1 items" })]), "cart, 1 items")).toBe(true);
    expect(pageHasText(page([el("e1", { name: "Cart, 1 items", visible: false })]), "Cart, 1 items")).toBe(false);
  });

  test("[REQ-DOM-004] the model sees only visible elements, grouped by frame, with refs", () => {
    const text = serializeSnapshot(
      page([
        el("e1", { role: "textbox", name: "Имя", text: "", value: "Анна", tag: "input", attrs: { type: "text" }, states: ["required"] }),
        el("e2", { visible: false, name: "Скрытая" }),
        el("e3", { frame: "http://pay/consent", role: "checkbox", name: "Согласен", shadowHost: "x-pay", context: "Условия Согласен" }),
        el("e4", { role: "combobox", name: "Доставка", options: ["Курьер", "Почта"] }),
      ]),
    );
    expect(text).toContain('[e1] textbox "Имя" value="Анна" type=text (required)');
    expect(text).not.toContain("Скрытая");
    expect(text).toContain("--- frame http://pay/consent ---");
    expect(text).toContain('[e3] checkbox "Согласен" text="В корзину" in "Условия Согласен" shadow:x-pay');
    expect(text).toContain('options="Курьер | Почта"');
    expect(serializeSnapshot(page([el("e1")]), 20)).toContain("… (cut)");
  });
});

// A stand-in for Claude in tests: reads the same prompt (task, inputs, the serialized page) and answers by the same
// schema, knowing only the shapeshift shop. It sees text, never the agent: the server pipeline is tested as is.
import type { Model, ModelRequest } from "../../apps/control-plane/src/llm/model.ts";

interface Line {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: string;
  context: string;
}

const SYNONYMS: Record<string, string[]> = {
  search: ["Поиск товаров", "Что ищем?"],
  find: ["Найти", "Искать"],
  add: ["В корзину", "Купить"],
  toCheckout: ["Перейти к оформлению", "К оплате"],
  name: ["Имя", "Как вас зовут"],
  phone: ["Телефон", "Номер для связи"],
  address: ["Адрес", "Куда доставить"],
  delivery: ["Способ доставки", "Доставка"],
  consent: ["Я согласен с условиями", "Принимаю условия"],
  place: ["Оформить заказ", "Подтвердить покупку"],
};
const kindOf = (name: string) => Object.entries(SYNONYMS).find(([, names]) => names.includes(name))?.[0];

function parsePage(prompt: string): { url: string; lines: Line[] } {
  const url = /^URL: (.*)$/m.exec(prompt)?.[1] ?? "";
  const lines: Line[] = [];
  for (const raw of prompt.split("\n")) {
    const m = /^\[(e\d+)\] (\S+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(raw);
    if (!m) continue;
    const rest = m[4]!;
    lines.push({
      ref: m[1]!,
      role: m[2]!,
      name: JSON.parse(`"${m[3] ?? ""}"`),
      ...(/value="([^"]*)"/.exec(rest) && { value: /value="([^"]*)"/.exec(rest)![1] }),
      states: /\(([^)]*)\)/.exec(rest)?.[1] ?? "",
      context: /in "((?:[^"\\]|\\.)*)"/.exec(rest)?.[1] ?? "",
    });
  }
  return { url, lines };
}

const inputValue = (prompt: string, key: string) => JSON.parse(new RegExp(`^- ${key} = (".*")$`, "m").exec(prompt)?.[1] ?? '""') as string;

export interface FakeModel extends Model {
  calls: { purpose: string; runId: string }[];
}

export function fakeShopModel(): FakeModel {
  const calls: FakeModel["calls"] = [];
  const find = (lines: Line[], kind: string, role?: string) => lines.find((l) => kindOf(l.name) === kind && (!role || l.role === role));

  const record = (prompt: string) => {
    const { url, lines } = parsePage(prompt);
    const path = new URL(url).pathname;
    const item = inputValue(prompt, "item");
    const act = (kind: "click" | "fill" | "select", line: Line | undefined, intent: string, extra: { value?: string; mutating?: boolean } = {}) =>
      line ? { thought: intent, decision: "act", action: { kind, ref: line.ref, intent, mutating: extra.mutating ?? false, ...(extra.value !== undefined && { value: extra.value }) } } : { thought: "lost", decision: "fail", reason: `nothing to ${intent}` };

    if (path.startsWith("/order/")) return { thought: "done", decision: "done", previousCheck: { url: "/order/", text: "оформлен" }, result: { text: "оформлен" } };
    if (path === "/") {
      const search = find(lines, "search", "searchbox");
      if (!url.includes("q=") && !search?.value) return act("fill", search, "Ввести название товара в поиск", { value: "{{input.query}}" });
      if (!url.includes("q=")) return act("click", find(lines, "find", "button"), "Нажать «Найти»");
      return act("click", lines.find((l) => l.role === "button" && kindOf(l.name) === "add" && l.context.includes(item)), "Положить товар в корзину", { mutating: true });
    }
    if (path === "/cart") return { ...act("click", find(lines, "toCheckout", "link"), "Перейти к оформлению"), previousCheck: { url: "/cart", text: item } };
    if (path === "/checkout") {
      for (const [kind, key] of [["name", "name"], ["phone", "phone"], ["address", "address"]] as const) {
        const field = find(lines, kind, "textbox");
        if (field && !field.value) return act("fill", field, `Заполнить поле «${field.name}»`, { value: `{{input.${key}}}` });
      }
      const delivery = find(lines, "delivery", "combobox");
      if (delivery && delivery.value !== inputValue(prompt, "delivery")) return act("select", delivery, "Выбрать способ доставки", { value: "{{input.delivery}}" });
      const consent = find(lines, "consent", "checkbox");
      if (consent && !consent.states.includes("checked")) return act("click", consent, "Согласиться с условиями");
      return act("click", find(lines, "place", "button"), "Оформить заказ", { mutating: true });
    }
    return { thought: "unknown page", decision: "fail", reason: `unexpected page ${path}` };
  };

  const heal = (prompt: string) => {
    const { lines } = parsePage(prompt);
    const was = /^Recorded element: (\S+) “([^”]*)”(?: in “([^”]*)”)?/m.exec(prompt);
    const role = was?.[1] ?? "";
    const kind = kindOf(was?.[2] ?? "");
    const candidates = lines.filter((l) => l.role === role && kindOf(l.name) === kind && l.name !== was?.[2]);
    const context = was?.[3] ?? "";
    const pick = candidates.find((l) => !context || words(context).some((w) => l.context.includes(w))) ?? candidates[0];
    return pick ? { ref: pick.ref, note: `Элемент теперь называется «${pick.name}»` } : { ref: null, note: "Подходящего элемента нет" };
  };

  return {
    calls,
    async ask(req: ModelRequest) {
      calls.push({ purpose: req.purpose, runId: req.runId });
      const output = req.purpose === "record" ? record(req.prompt) : heal(req.prompt);
      if (process.env.BAP_TEST_MODEL_LOG) console.log(`[fake-model] ${req.purpose}: ${JSON.stringify(output)} @ ${/^URL: (.*)$/m.exec(req.prompt)?.[1]} last=${/^Last action: (.*)$/m.exec(req.prompt)?.[1]}`);
      return { output, model: "fake-shop", durationMs: 1, costUsd: 0, inputTokens: req.prompt.length, outputTokens: 10 };
    },
  };
}

const words = (s: string) => s.split(/\s+/).filter((w) => w.length > 3);

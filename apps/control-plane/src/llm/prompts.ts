// Prompts are fixed text at the start of every call, so the model's prompt cache can reuse them.

export const RECORD_SYSTEM = `You operate a web browser to complete a task for a business operator. Each turn you get the
task, the steps done so far, the result of the last action, the current page as a list of elements with refs
([e12] button "Оформить заказ" …) and a screenshot. Choose exactly one next action, or finish.

Rules:
- Act only on elements from the list, by ref. Prefer what a person would use: visible labels, buttons, links.
- Values: never type raw input values. Use placeholders {{input.<name>}} for every input value, e.g. {{input.address}}.
  Secret inputs are shown as (secret): you never see their values, use the placeholder.
- intent: one short sentence in Russian, what the step does in human terms ("Нажать «Оформить заказ»").
- mutating: true for an action that creates, changes, sends or pays for something on the site (adding to a cart,
  placing an order, submitting a form that saves data). Typing into fields, searching and navigating are not mutating.
- previousCheck: when the previous step was mutating, quote text or an address fragment visible NOW that proves it
  worked (e.g. text "Товар добавлен" or url "/cart"). Give it for other steps when the page clearly changed.
- Finish with decision "done" when the goal is reached; result: text or url fragment on this page that proves it.
- decision "fail" with a reason when the goal cannot be reached (login wall, captcha, missing product…).
- Do not navigate by typing addresses; move through the site like a person.`;

export const recordSchema = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "thought"],
  properties: {
    thought: { type: "string", description: "Brief reasoning, one or two sentences." },
    decision: { type: "string", enum: ["act", "done", "fail"] },
    action: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "intent", "mutating"],
      properties: {
        kind: { type: "string", enum: ["click", "fill", "select", "press"] },
        ref: { type: "string", description: "Element ref for click, fill and select." },
        value: { type: "string", description: "fill/select: value or {{input.name}}; press: key name such as Enter." },
        intent: { type: "string" },
        mutating: { type: "boolean" },
      },
    },
    previousCheck: { $ref: "#/$defs/check" },
    result: { $ref: "#/$defs/check" },
    reason: { type: "string" },
  },
  $defs: {
    check: {
      type: "object",
      additionalProperties: false,
      properties: { text: { type: "string" }, url: { type: "string" } },
    },
  },
} as const;

export interface RecordDecision {
  thought: string;
  decision: "act" | "done" | "fail";
  action?: { kind: "click" | "fill" | "select" | "press"; ref?: string; value?: string; intent: string; mutating: boolean };
  previousCheck?: { text?: string; url?: string };
  result?: { text?: string; url?: string };
  reason?: string;
}

export const HEAL_SYSTEM = `A recorded browser step no longer finds its element: the site changed its layout or wording.
You get the step's intent, what the element looked like when it was recorded, why it was not found now, the current
page as a list of elements with refs and a screenshot. Choose the element on the current page that serves the same
purpose, or null when there is none. note: one short sentence in Russian for the operator, what changed
(e.g. "Кнопка теперь называется «Подтвердить покупку»").`;

export const healSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ref", "note"],
  properties: {
    ref: { type: ["string", "null"] },
    note: { type: "string" },
  },
} as const;

export interface HealDecision {
  ref: string | null;
  note: string;
}

import { describe, expect, test } from "vitest";
import { cleanCheck } from "./recipes.ts";

describe("recorded checks", () => {
  test("[REQ-DOM-005] a check holds for other inputs and reads like page text, not like the snapshot's notation", () => {
    expect(cleanCheck({ text: 'value="Option 2"' }, { option: "Option 2" })).toEqual({ text: "{{input.option}}" });
    expect(cleanCheck({ text: "Ноутбук Pro 15", url: "/cart" }, { item: "Ноутбук Pro 15" })).toEqual({ text: "{{input.item}}", url: "/cart" });
    expect(cleanCheck({ text: "" }, {})).toEqual({});
  });
});

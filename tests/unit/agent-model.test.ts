import { describe, expect, test } from "vitest";
import { parseModel } from "../../apps/mac-agent/src/model.ts";

const hardware = (overview: Record<string, string>) => JSON.stringify({ SPHardwareDataType: [{ _name: "hardware_overview", serial_number: "KMRWW9FX0D", ...overview }] });

describe("Mac model", () => {
  test("[REQ-UI-007] Apple silicon: name, chip and memory; nothing identifying the machine", () => {
    const model = parseModel(hardware({ machine_name: "MacBook Air", machine_model: "Mac17,4", chip_type: "Apple M5", physical_memory: "16 GB" }));
    expect(model).toBe("MacBook Air · Apple M5 · 16 GB");
  });

  test("[REQ-UI-007] Intel: the processor stands for the chip", () => {
    expect(parseModel(hardware({ machine_name: "MacBook Pro", cpu_type: "Quad-Core Intel Core i7", physical_memory: "16 GB" }))).toBe("MacBook Pro · Quad-Core Intel Core i7 · 16 GB");
  });

  test("[REQ-UI-007] unreadable output gives no model", () => {
    expect(parseModel("")).toBeNull();
    expect(parseModel(JSON.stringify({ SPHardwareDataType: [] }))).toBeNull();
    expect(parseModel(hardware({ physical_memory: "16 GB" }))).toBeNull();
  });
});

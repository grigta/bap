import { execFileSync } from "node:child_process";
import { platform } from "node:os";

/** "MacBook Air · Apple M5 · 16 GB" from `system_profiler SPHardwareDataType -json`; serial numbers and UUIDs stay out. */
export function parseModel(json: string): string | null {
  try {
    const hw = (JSON.parse(json) as { SPHardwareDataType?: Record<string, string>[] }).SPHardwareDataType?.[0];
    if (!hw?.machine_name) return null;
    return [hw.machine_name, hw.chip_type ?? hw.cpu_type, hw.physical_memory].filter(Boolean).join(" · ");
  } catch {
    return null;
  }
}

/** Read once when the agent starts: the hardware does not change while it runs. */
export function readModel(): string | null {
  if (platform() !== "darwin") return null;
  try {
    return parseModel(execFileSync("system_profiler", ["SPHardwareDataType", "-json"], { encoding: "utf8", timeout: 20_000 }));
  } catch {
    return null;
  }
}

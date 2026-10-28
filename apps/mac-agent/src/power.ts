import { execFileSync } from "node:child_process";
import { platform } from "node:os";
import type { PowerState } from "@bap/protocol";

/**
 * Reads `pmset -g batt` (power source, battery) and `pmset -g` (sleep settings). A Mac working
 * around the clock must stay on the charger and must not sleep; the panel warns otherwise.
 */
export function parsePower(batt: string, settings: string): PowerState {
  const from = /drawing from '([^']+)'/.exec(batt)?.[1] ?? "";
  const source = /^AC/.test(from) ? "ac" : /Battery/.test(from) ? "battery" : "unknown";
  const battery = /InternalBattery[^\t]*\t(\d+)%;\s*([^;]+);/.exec(batt);
  const sleep = /^\s*sleep\s+(\d+)/m.exec(settings)?.[1];
  const disabled = /^\s*SleepDisabled\s+1/m.test(settings);
  return {
    source,
    batteryPercent: battery ? Number(battery[1]) : null,
    charging: battery ? battery[2]!.trim() === "charging" : null,
    sleepPrevented: sleep === undefined && !disabled ? null : disabled || sleep === "0",
  };
}

export function readPower(): PowerState | null {
  if (platform() !== "darwin") return null;
  try {
    return parsePower(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }), execFileSync("pmset", ["-g"], { encoding: "utf8" }));
  } catch {
    return null;
  }
}

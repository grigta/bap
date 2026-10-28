import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
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

const run = promisify(execFile);
const REFRESH_MS = 30_000;
let cached: { at: number; value: PowerState | null } | null = null;
let refreshing = false;

/**
 * The last reading, refreshed in the background at most every 30 s: power changes slowly, and the
 * heartbeat must not wait for (or block on) two pmset processes.
 */
export function readPower(): PowerState | null {
  if (platform() !== "darwin") return null;
  if (!refreshing && (!cached || Date.now() - cached.at > REFRESH_MS)) {
    refreshing = true;
    void Promise.all([run("pmset", ["-g", "batt"]), run("pmset", ["-g"])])
      .then(([batt, settings]) => (cached = { at: Date.now(), value: parsePower(batt.stdout, settings.stdout) }))
      .catch(() => (cached = { at: Date.now(), value: null }))
      .finally(() => (refreshing = false));
  }
  return cached?.value ?? null;
}

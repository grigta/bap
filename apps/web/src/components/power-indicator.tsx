import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Moon, Plug } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Power } from "@/lib/types";
import { cn } from "@/lib/utils";

/** What the operator should worry about: off the charger, a low battery, or a Mac that may sleep. */
export function powerProblem(p: Power | null | undefined): string | null {
  if (!p) return null;
  if (p.source === "battery") return `от батареи${p.batteryPercent !== null ? `, ${p.batteryPercent}%` : ""}: подключите зарядку`;
  if (p.sleepPrevented === false) return "сон не отключён: Mac может уснуть";
  return null;
}

function describe(p: Power): string {
  const battery = p.batteryPercent === null ? "без батареи" : `батарея ${p.batteryPercent}%${p.charging ? ", заряжается" : ""}`;
  const source = p.source === "ac" ? "от сети" : p.source === "battery" ? "от батареи" : "источник неизвестен";
  const sleep = p.sleepPrevented === null ? "" : p.sleepPrevented ? ", сон отключён" : ", сон НЕ отключён";
  return `${source}, ${battery}${sleep}`;
}

/** Compact power state for tables: an icon, the charge, and a moon when the Mac may sleep. */
export function PowerIndicator({ power, className }: { power: Power | null | undefined; className?: string }) {
  if (!power) return <span className="text-muted-foreground">—</span>;
  const problem = powerProblem(power);
  const pct = power.batteryPercent;
  const Icon = power.source === "ac" ? (pct === null ? Plug : power.charging ? BatteryCharging : BatteryFull) : pct !== null && pct < 25 ? BatteryLow : BatteryMedium;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-testid="agent-power"
            data-problem={problem ? "true" : undefined}
            className={cn("inline-flex items-center gap-1 tabular-nums", problem ? "text-fail" : "text-muted-foreground", className)}
          />
        }
      >
        <Icon className="size-4" aria-hidden />
        {pct !== null && <span>{pct}%</span>}
        {power.sleepPrevented === false && <Moon className="size-3.5" aria-hidden />}
        <span className="sr-only">{describe(power)}</span>
      </TooltipTrigger>
      <TooltipContent>{problem ?? describe(power)}</TooltipContent>
    </Tooltip>
  );
}

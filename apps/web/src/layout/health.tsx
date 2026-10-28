import { useQuery } from "@tanstack/react-query";
import { DatabaseZap } from "lucide-react";
import { HttpError, api } from "@/lib/api";
import type { Health } from "@/lib/types";
import { cn } from "@/lib/utils";

// Polling every 2 s with a 1.5 s timeout keeps the indicator within the 5 s budget (REQ-UI-001).
const HEALTH_POLL_MS = 2000;

/** A 503 still carries the health body: the Control Plane answers, the database does not. */
async function fetchHealth(): Promise<Health> {
  try {
    return await api<Health>("/health", { timeoutMs: 1500 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 503) return { status: "degraded", database: "down" };
    throw e;
  }
}

export const useHealth = () => useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: HEALTH_POLL_MS, refetchIntervalInBackground: true });

export function HealthIndicator() {
  const health = useHealth();
  const online = health.isSuccess && !health.isError;
  return (
    <span
      role="status"
      data-testid="health"
      className={cn("inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium", online ? "bg-ok-soft text-ok" : "bg-fail-soft text-fail")}
    >
      <span aria-hidden className={cn("size-2 rounded-full", online ? "bg-ok" : "bg-fail")} />
      Control Plane: {online ? "online" : "offline"}
    </span>
  );
}

export function DatabaseBanner() {
  const health = useHealth();
  if (health.data?.database !== "down" || health.isError) return null;
  return (
    <div role="alert" data-testid="database-banner" className="flex items-center gap-3 border-b border-fail/30 bg-fail-soft px-6 py-2.5 text-sm text-fail">
      <DatabaseZap className="size-4 shrink-0" aria-hidden />
      База данных недоступна: изменения не сохраняются, данные на экране могут быть устаревшими. Панель обновится, когда база вернётся.
    </div>
  );
}

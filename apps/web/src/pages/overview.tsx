import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { StatusBadge, toneOf } from "@/components/status-badge";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { ago, shortId, useNow } from "@/lib/format";
import type { Agent, ReviewQueue, Run } from "@/lib/types";
import { cn } from "@/lib/utils";

const POLL_MS = 2000;
const HOUR = 3_600_000;

/** One reading on the instrument row: a number, what it counts, and where to look next. */
function Reading({ label, value, of, tone, to, testId }: { label: string; value: number; of?: number; tone?: "fail" | "wait"; to: string; testId: string }) {
  return (
    <Link to={to} data-testid={testId} className="group grid gap-1 bg-card px-4 py-3 hover:bg-muted/50 focus-visible:bg-muted/50">
      <span className="text-xs text-muted-foreground group-hover:text-foreground">{label}</span>
      <span className={cn("text-2xl font-semibold tabular-nums", tone === "fail" && value > 0 && "text-fail", tone === "wait" && value > 0 && "text-wait")}>
        <span data-slot="value">{value}</span>
        {of !== undefined && <span className="text-base font-normal text-muted-foreground"> / {of}</span>}
      </span>
    </Link>
  );
}

/** Each Mac as a row of its session slots: filled while a run holds the slot. */
function Fleet({ agents }: { agents: Agent[] }) {
  const now = useNow();
  return (
    <section aria-labelledby="fleet-title" className="rounded-lg border bg-card">
      <h2 id="fleet-title" className="border-b px-4 py-3 text-sm font-medium">
        Парк
      </h2>
      {agents.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Агентов пока нет.</p>
      ) : (
        <ul className="divide-y">
          {agents.map((a) => {
            const slots = a.maxSessions ?? 0;
            return (
              <li key={a.id}>
                <Link to="/agents/$agentId" params={{ agentId: a.id }} className="flex flex-wrap items-center gap-3 px-4 py-2.5 hover:bg-muted/50">
                  <span className="w-40 truncate text-sm font-medium">{a.name}</span>
                  <StatusBadge status={a.connection} />
                  <span className="flex gap-1" aria-label={`Занято слотов: ${a.activeRuns} из ${slots}`}>
                    {Array.from({ length: slots }, (_, i) => (
                      <span key={i} className={cn("h-3 w-5 rounded-[3px] border", i < a.activeRuns ? "border-busy bg-busy" : "border-border bg-muted")} />
                    ))}
                  </span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {a.heartbeat ? `CPU ${a.heartbeat.cpuPercent.toFixed(0)}%, RAM ${a.heartbeat.memoryPercent.toFixed(0)}%` : "нет данных"}, {ago(a.lastSeenAt, now)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const chartConfig = { ok: { label: "Успешно", color: "var(--ok)" }, fail: { label: "Ошибка", color: "var(--fail)" }, wait: { label: "На проверку", color: "var(--wait)" } };

/** Finished runs per hour over the last 24 hours. */
function Throughput({ runs, now }: { runs: Run[]; now: number }) {
  const start = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const buckets = Array.from({ length: 24 }, (_, i) => ({ hour: new Date(start + i * HOUR).getHours().toString().padStart(2, "0"), ok: 0, fail: 0, wait: 0 }));
  for (const r of runs) {
    if (!r.finishedAt) continue;
    const i = Math.floor((Date.parse(r.finishedAt) - start) / HOUR);
    const tone = toneOf(r.status);
    if (i >= 0 && i < 24 && (tone === "ok" || tone === "fail" || tone === "wait")) buckets[i]![tone]++;
  }
  return (
    <section aria-labelledby="throughput-title" className="rounded-lg border bg-card">
      <h2 id="throughput-title" className="border-b px-4 py-3 text-sm font-medium">
        Завершённые задания по часам, 24 ч
      </h2>
      <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full p-3">
        <BarChart data={buckets} margin={{ left: -20, right: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="hour" tickLine={false} axisLine={false} interval={2} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={40} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="ok" stackId="r" fill="var(--color-ok)" isAnimationActive={false} />
          <Bar dataKey="wait" stackId="r" fill="var(--color-wait)" isAnimationActive={false} />
          <Bar dataKey="fail" stackId="r" fill="var(--color-fail)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
    </section>
  );
}

function RecentProblems({ runs }: { runs: Run[] }) {
  const problems = runs.filter((r) => r.status === "FAILED" || r.status === "NEEDS_REVIEW" || r.status === "RECOVERY_PENDING").slice(0, 6);
  return (
    <section aria-labelledby="problems-title" className="rounded-lg border bg-card">
      <h2 id="problems-title" className="border-b px-4 py-3 text-sm font-medium">
        Последние проблемы
      </h2>
      {problems.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">Ошибок нет.</p>
      ) : (
        <ul className="divide-y">
          {problems.map((r) => (
            <li key={r.id}>
              <Link to="/runs/$runId" params={{ runId: r.id }} className="grid gap-1 px-4 py-2.5 hover:bg-muted/50">
                <span className="flex items-center gap-2 text-sm">
                  <StatusBadge status={r.status} />
                  <span className="truncate">{r.scenarioId}</span>
                  <span className="ml-auto font-mono text-xs text-muted-foreground">{shortId(r.id)}</span>
                </span>
                {r.errorCode && <span className="truncate font-mono text-xs text-fail">{r.errorCode}: {r.errorMessage}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OverviewPage() {
  const now = useNow();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/agents"), refetchInterval: POLL_MS });
  const runs = useQuery({ queryKey: ["runs", "overview"], queryFn: () => api<Run[]>("/runs?limit=500"), refetchInterval: POLL_MS });
  const review = useQuery({ queryKey: ["review"], queryFn: () => api<ReviewQueue>("/review"), refetchInterval: POLL_MS });

  const a = agents.data ?? [];
  const r = runs.data ?? [];
  const day = r.filter((x) => x.finishedAt && now - Date.parse(x.finishedAt) < 24 * HOUR);
  const fleet = a.filter((x) => x.status !== "REVOKED");
  return (
    <>
      <PageHeader title="Обзор" description="Состояние парка и заданий сейчас. Обновляется каждые 2 секунды." />
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Reading testId="reading-online" label="Агенты на связи" value={fleet.filter((x) => x.connection === "ONLINE").length} of={fleet.length} to="/agents" />
        <Reading testId="reading-slots" label="Занято слотов" value={fleet.reduce((s, x) => s + x.activeRuns, 0)} of={fleet.reduce((s, x) => s + (x.maxSessions ?? 0), 0)} to="/agents" />
        <Reading testId="reading-running" label="Выполняются" value={r.filter((x) => ["ASSIGNED", "ACCEPTED", "RUNNING", "CANCEL_REQUESTED"].includes(x.status)).length} to="/runs" />
        <Reading testId="reading-queued" label="В очереди" value={r.filter((x) => x.status === "QUEUED").length} to="/runs" />
        <Reading testId="reading-failed" label="Ошибки за 24 ч" value={day.filter((x) => x.status === "FAILED").length} tone="fail" to="/runs" />
        <Reading testId="reading-review" label="Ждут проверки" value={(review.data?.runs.length ?? 0) + (review.data?.profiles.length ?? 0)} tone="wait" to="/review" />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="grid content-start gap-6">
          <Throughput runs={r} now={now} />
          <Fleet agents={fleet} />
        </div>
        <RecentProblems runs={r} />
      </div>
    </>
  );
}

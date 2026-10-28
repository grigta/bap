import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Copy, Monitor, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useConfirm } from "@/components/confirm";
import { type Column, DataTable, columns } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { ago, time, useNow } from "@/lib/format";
import { notifyDone, notifyError } from "@/lib/notify";
import type { Agent, AgentCard as AgentCardData } from "@/lib/types";

const POLL_MS = 2000;
type AgentAction = "drain" | "disable" | "activate" | "revoke" | "rotate-key";

function InvitePanel({ invite }: { invite: { token: string; expiresAt: string } }) {
  const [copied, setCopied] = useState(false);
  const command = `bap-agent enroll --server ${location.origin} --token ${invite.token}`;
  return (
    <div data-testid="invite" className="mb-6 rounded-lg border border-primary/30 bg-busy-soft/40 p-4">
      <p className="text-sm">Одноразовое приглашение, действует до {time(invite.expiresAt)}. Выполните на Mac:</p>
      <div className="mt-2 flex items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs">
          bap-agent enroll --server {location.origin} --token <span data-testid="invite-token">{invite.token}</span>
        </pre>
        <Button
          variant="outline"
          size="icon"
          aria-label="Скопировать команду"
          onClick={() => {
            void navigator.clipboard?.writeText(command);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

function SessionLimit({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(agent.sessionLimit === null ? "" : String(agent.sessionLimit));
  const save = useMutation({
    mutationFn: () => api(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ sessionLimit: value === "" ? null : Number(value) }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      notifyDone("Лимит сохранён");
    },
    onError: notifyError("Лимит сессий"),
  });
  return (
    <form
      className="grid gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Label htmlFor="session-limit">Лимит сессий</Label>
      <div className="flex gap-2">
        <Input
          id="session-limit"
          type="number"
          min={0}
          max={100}
          value={value}
          placeholder={`агент сообщает ${agent.reportedMaxSessions ?? "—"}`}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Лимит сессий"
          className="w-40"
        />
        <Button type="submit" variant="outline">
          Сохранить
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Пусто — сколько сообщает сам агент.</p>
    </form>
  );
}

const usageChart = { cpu: { label: "CPU", color: "var(--chart-1)" }, ram: { label: "RAM", color: "var(--chart-2)" } };

function Usage({ heartbeats }: { heartbeats: AgentCardData["heartbeats"] }) {
  const data = heartbeats.map((b) => ({ at: time(b.at), cpu: Math.round(b.cpuPercent), ram: Math.round(b.memoryPercent) }));
  const last = heartbeats.at(-1);
  return (
    <section aria-label="Нагрузка" className="grid gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium">Нагрузка</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          CPU {last ? `${last.cpuPercent.toFixed(0)}%` : "—"} · RAM {last ? `${last.memoryPercent.toFixed(0)}%` : "—"}
        </span>
      </div>
      <ChartContainer config={usageChart} className="aspect-auto h-36 w-full">
        <AreaChart data={data} margin={{ left: 0, right: 4, top: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="at" tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tickLine={false} axisLine={false} width={44} tickFormatter={(v: number) => `${v}%`} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Area dataKey="cpu" type="monotone" stroke="var(--color-cpu)" fill="var(--color-cpu)" fillOpacity={0.15} isAnimationActive={false} />
          <Area dataKey="ram" type="monotone" stroke="var(--color-ram)" fill="var(--color-ram)" fillOpacity={0.1} isAnimationActive={false} />
        </AreaChart>
      </ChartContainer>
      <p className="text-xs text-muted-foreground">Последние {heartbeats.length} heartbeat</p>
    </section>
  );
}

function AgentSheet({ id }: { id: string | undefined }) {
  const navigate = useNavigate();
  const now = useNow();
  const card = useQuery({ queryKey: ["agent", id], queryFn: () => api<AgentCardData>(`/agents/${id}`), refetchInterval: POLL_MS, enabled: !!id });
  const a = card.data;
  return (
    <Sheet open={!!id} onOpenChange={(open) => !open && navigate({ to: "/agents" })}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        {a && (
          <div data-testid="agent-card" className="flex h-full flex-col">
            <SheetHeader className="border-b">
              <SheetTitle>{a.name}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusBadge status={a.status} />
                <StatusBadge status={a.connection} />
                <span>последний сигнал {ago(a.lastSeenAt, now)}</span>
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-6 overflow-y-auto p-4">
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground">Слоты</dt>
                  <dd className="tabular-nums">{a.maxSessions !== null ? `${a.activeRuns} / ${a.maxSessions}` : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Linken Sphere</dt>
                  <dd>{a.heartbeat ? (a.heartbeat.lsAvailable ? "доступен" : "недоступен") : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Версия агента</dt>
                  <dd className="font-mono text-xs">{a.agentVersion ?? "—"}</dd>
                </div>
              </dl>
              <Usage heartbeats={a.heartbeats} />
              <SessionLimit agent={a} />
              <p className="text-xs text-muted-foreground" data-testid="duplicates">
                Повторно доставленных сообщений отброшено: {a.duplicateMessages}
              </p>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function AgentActions({ agent: a, act }: { agent: Agent; act: (id: string, action: AgentAction) => void }) {
  const confirm = useConfirm();
  const revoke = async () => {
    if (await confirm({ title: `Отозвать ключ агента ${a.name}?`, description: "Агент сразу отключится и не сможет подключиться снова. Вернуть узел можно только новым приглашением.", action: "Отозвать", destructive: true }))
      act(a.id, "revoke");
  };
  return (
    <div className="flex justify-end gap-1">
      {a.status === "DRAINING" || a.status === "DISABLED" ? (
        <Button size="xs" variant="outline" onClick={() => act(a.id, "activate")}>
          Activate
        </Button>
      ) : (
        <Button size="xs" variant="outline" disabled={a.status !== "ACTIVE"} onClick={() => act(a.id, "drain")}>
          Drain
        </Button>
      )}
      <Button size="xs" variant="outline" disabled={a.status === "DISABLED" || a.status === "REVOKED"} onClick={() => act(a.id, "disable")}>
        Disable
      </Button>
      <Button size="xs" variant="outline" disabled={a.status === "REVOKED" || a.connection !== "ONLINE"} onClick={() => act(a.id, "rotate-key")}>
        Rotate key
      </Button>
      <Button size="xs" variant="destructive" disabled={a.status === "REVOKED"} onClick={revoke}>
        Revoke
      </Button>
    </div>
  );
}

export function AgentsPage({ agentId }: { agentId?: string }) {
  const queryClient = useQueryClient();
  const now = useNow();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/agents"), refetchInterval: POLL_MS });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: AgentAction }) => api(`/agents/${id}/${action}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
    onError: notifyError("Действие с агентом"),
  });
  const run = (id: string, action: AgentAction) => act.mutate({ id, action });
  const invite = useMutation({ mutationFn: () => api<{ token: string; expiresAt: string }>("/agents/enrollments", { method: "POST" }), onError: notifyError("Приглашение") });

  const c = columns<Agent>();
  const cols: Column<Agent>[] = [
    c.accessor("name", {
      header: "Агент",
      cell: (i) => (
        <Link to="/agents/$agentId" params={{ agentId: i.row.original.id }} className="font-medium hover:underline">
          {i.getValue()}
        </Link>
      ),
    }),
    c.accessor("status", { header: "Статус", cell: (i) => <StatusBadge status={i.getValue()} data-testid="agent-status" /> }),
    c.accessor("connection", { header: "Связь", cell: (i) => <StatusBadge status={i.getValue()} data-testid="agent-connection" /> }),
    c.accessor("lastSeenAt", { header: "Последний сигнал", cell: (i) => <span className="text-muted-foreground tabular-nums">{ago(i.getValue(), now)}</span> }),
    c.accessor((a) => a.heartbeat?.lsAvailable, {
      id: "ls",
      header: "LS",
      cell: (i) => {
        const v = i.getValue();
        return (
          <span data-testid="agent-ls" aria-label={v === undefined ? "нет данных" : v ? "Linken Sphere доступен" : "Linken Sphere недоступен"} className={v ? "text-ok" : v === false ? "text-fail" : "text-muted-foreground"}>
            {v === undefined ? "—" : v ? <Check className="inline size-4" aria-hidden /> : <X className="inline size-4" aria-hidden />}
            <span className="sr-only">{v === undefined ? "—" : v ? "✓" : "✗"}</span>
          </span>
        );
      },
    }),
    c.accessor((a) => a.heartbeat?.cpuPercent ?? -1, {
      id: "load",
      header: "CPU / RAM",
      cell: (i) => {
        const h = i.row.original.heartbeat;
        return <span className="tabular-nums">{h ? `${h.cpuPercent.toFixed(0)}% / ${h.memoryPercent.toFixed(0)}%` : "—"}</span>;
      },
    }),
    c.accessor("activeRuns", {
      header: "Слоты",
      cell: (i) => (
        <span data-testid="slots" className="tabular-nums">
          {i.row.original.maxSessions !== null ? `${i.getValue()} / ${i.row.original.maxSessions}` : "—"}
        </span>
      ),
    }),
    c.accessor("agentVersion", { header: "Версия", cell: (i) => <span className="font-mono text-xs text-muted-foreground">{i.getValue() ?? "—"}</span> }),
    c.display({ id: "actions", header: () => <span className="sr-only">Действия</span>, cell: (i) => <AgentActions agent={i.row.original} act={run} /> }),
  ];

  return (
    <>
      <PageHeader
        title="Агенты"
        description="Mac с Linken Sphere, которые выполняют задания. Связь и нагрузка обновляются каждые 2 секунды."
        actions={
          <Button onClick={() => invite.mutate()}>
            <UserPlus aria-hidden />
            Пригласить агента
          </Button>
        }
      />
      {invite.data && <InvitePanel invite={invite.data} />}
      {agents.data?.length === 0 && <EmptyState icon={Monitor} title="Агентов пока нет" description="Пригласите первый Mac: команда регистрации появится здесь." />}
      {!!agents.data?.length && <DataTable id="agents" data={agents.data} columns={cols} rowTestId={(a) => `agent-${a.name}`} />}
      <AgentSheet id={agentId} />
    </>
  );
}

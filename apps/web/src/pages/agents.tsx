import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Copy, Ellipsis, KeyRound, Monitor, Pause, Play, Power, ShieldOff, Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { useConfirm } from "@/components/confirm";
import { type Column, DataTable, columns } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PowerIndicator, powerProblem } from "@/components/power-indicator";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { ago, time, useNow } from "@/lib/format";
import { notifyDone, notifyError } from "@/lib/notify";
import type { Agent, AgentCard as AgentCardData } from "@/lib/types";

const POLL_MS = 2000;
type AgentAction = "drain" | "disable" | "activate" | "revoke" | "rotate-key" | "delete";

interface Invite {
  id: string;
  token: string;
  expiresAt: string;
  installCommand: string | null;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="icon"
      aria-label="Скопировать команду"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/** A command line with the invitation marked, so it can be read back (and tests can find it). */
function CommandLine({ command, token }: { command: string; token: string }) {
  const [before, after] = command.split(token) as [string, string | undefined];
  return (
    <div className="flex items-start gap-2">
      <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
        {before}
        <span data-testid="invite-token">{token}</span>
        {after}
      </pre>
      <CopyButton text={command} />
    </div>
  );
}

/** Connecting a new Mac: one line to paste in its Terminal, and the invitation's status live. */
function ConnectMacDialog({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  const status = useQuery({
    queryKey: ["enrollment", invite.id],
    queryFn: () => api<{ usedAt: string | null; agent: { id: string; name: string; connection: string } | null }>(`/agents/enrollments/${invite.id}`),
    refetchInterval: (q) => (q.state.data?.agent?.connection === "ONLINE" ? false : POLL_MS),
  });
  const agent = status.data?.agent;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="invite">
        <DialogHeader>
          <DialogTitle>Подключить Mac</DialogTitle>
          <DialogDescription>
            {invite.installCommand
              ? "Откройте Терминал на новом Mac и вставьте эту строку. Она поставит агента, зарегистрирует Mac и включит автозапуск — без sudo, около минуты."
              : "Сервер пока не виден с других Mac. Запустите на нём pnpm gateway и создайте приглашение заново — появится команда для установки. Mac, где агент уже установлен, можно зарегистрировать вручную:"}
          </DialogDescription>
        </DialogHeader>
        <CommandLine
          token={invite.token}
          command={invite.installCommand ?? `bap-agent enroll --server <адрес сервера> --token ${invite.token}`}
        />
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" role="status" data-testid="invite-status">
          {agent ? (
            <>
              <Check className="size-4 text-ok" aria-hidden />
              <Link to="/agents/$agentId" params={{ agentId: agent.id }} className="font-medium hover:underline" onClick={onClose}>
                {agent.name}
              </Link>
              <span>зарегистрирован</span>
              <StatusBadge status={agent.connection} className="ml-auto" />
            </>
          ) : (
            <>
              <Spinner aria-hidden />
              <span>Ждём Mac. Приглашение одноразовое, действует до {time(invite.expiresAt)}.</span>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
              {a.model && <p className="text-sm text-muted-foreground">{a.model}</p>}
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusBadge status={a.status} />
                <StatusBadge status={a.connection} />
                <span>последний сигнал {ago(a.lastSeenAt, now)}</span>
              </SheetDescription>
            </SheetHeader>
            <div className="grid gap-6 overflow-y-auto p-4">
              {powerProblem(a.heartbeat?.power) && (
                <p role="alert" className="rounded-md bg-fail-soft px-3 py-2 text-sm text-fail">
                  {powerProblem(a.heartbeat?.power)}
                  {a.heartbeat?.power?.sleepPrevented === false && ". На этом Mac:  sudo pmset -a sleep 0 disablesleep 1"}
                </p>
              )}
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Слоты</dt>
                  <dd className="tabular-nums">{a.maxSessions !== null ? `${a.activeRuns} / ${a.maxSessions}` : "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Linken Sphere</dt>
                  <dd>
                    <LsStatus agent={a} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Питание</dt>
                  <dd>
                    <PowerIndicator power={a.heartbeat?.power} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Версия агента</dt>
                  <dd>
                    <AgentVersion agent={a} />
                  </dd>
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

/** The agent's build; an installed agent on an old build updates itself as soon as it is idle. */
function AgentVersion({ agent: a }: { agent: Agent }) {
  return (
    <span data-testid="agent-version" className="inline-flex items-center gap-1.5">
      <span className="font-mono text-xs text-muted-foreground">{a.agentVersion ?? "—"}</span>
      {a.upToDate === false && (
        <Tooltip>
          <TooltipTrigger render={<span className="rounded-sm bg-wait-soft px-1 text-[10px] text-wait" />}>устарел</TooltipTrigger>
          <TooltipContent>Обновится сам, когда закончит текущие задания и будет на связи</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * Whether Linken Sphere answers on the Mac. When it does not, the status is a button: the agent opens
 * the app and answers once its API is up (about 20 s; it signs in by itself).
 */
function LsStatus({ agent: a }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: () => api<{ started: boolean }>(`/agents/${a.id}/ls/start`, { method: "POST" }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ["agents"] });
      void queryClient.invalidateQueries({ queryKey: ["agent", a.id] });
      notifyDone(r.started ? `Linken Sphere запущен на ${a.name}` : `Linken Sphere на ${a.name} уже работал`);
    },
    onError: notifyError("Запуск Linken Sphere"),
  });
  const v = a.heartbeat?.lsAvailable;
  if (v === undefined)
    return (
      <span data-testid="agent-ls" className="text-muted-foreground" aria-label="нет данных">
        —
      </span>
    );
  if (v && !start.isPending)
    return (
      <span data-testid="agent-ls" aria-label="Linken Sphere работает" className="inline-flex items-center gap-1 text-ok">
        <Check className="size-4" aria-hidden />
        <span className="sr-only">✓</span>
      </span>
    );
  const status = (
    <>
      <X className="size-4" aria-hidden />
      <span data-testid="agent-ls" className="sr-only">
        ✗
      </span>
    </>
  );
  if (a.connection !== "ONLINE" || a.status === "REVOKED")
    return (
      <span aria-label="Linken Sphere не отвечает" className="inline-flex items-center text-fail">
        {status}
      </span>
    );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="text-fail"
            aria-label={`Запустить Linken Sphere на ${a.name}`}
            disabled={start.isPending}
            onClick={() => start.mutate()}
          />
        }
      >
        {start.isPending ? (
          <>
            <Spinner aria-hidden />
            запуск…
          </>
        ) : (
          <>
            {status}
            запустить
          </>
        )}
      </TooltipTrigger>
      <TooltipContent>Linken Sphere не отвечает. Агент откроет его на этом Mac, это около 20 секунд.</TooltipContent>
    </Tooltip>
  );
}

/** One main action by status; the rest in a menu, so a row stays short. */
function AgentActions({ agent: a, act }: { agent: Agent; act: (id: string, action: AgentAction) => void }) {
  const confirm = useConfirm();
  const revoke = async () => {
    if (await confirm({ title: `Отозвать доступ агента ${a.name}?`, description: "Агент сразу отключится и не сможет подключиться снова. Вернуть узел можно только новым приглашением.", action: "Отозвать", destructive: true }))
      act(a.id, "revoke");
  };
  const remove = async () => {
    if (
      await confirm({
        title: `Удалить агента ${a.name}?`,
        description: "Агент и его профили исчезнут из панели. История заданий и скриншоты сохранятся. Этот Mac можно будет подключить заново под тем же именем.",
        action: "Удалить",
        destructive: true,
      })
    )
      act(a.id, "delete");
  };
  if (a.status === "REVOKED")
    return (
      <div className="flex justify-end">
        <Button size="xs" variant="outline" className="text-destructive" onClick={remove}>
          <Trash2 aria-hidden />
          Удалить
        </Button>
      </div>
    );
  const paused = a.status === "DRAINING" || a.status === "DISABLED";
  return (
    <div className="flex items-center justify-end gap-1">
      {paused ? (
        <Button size="xs" variant="outline" onClick={() => act(a.id, "activate")}>
          <Play aria-hidden />
          Возобновить
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<Button size="xs" variant="outline" onClick={() => act(a.id, "drain")} />}>
            <Pause aria-hidden />
            Пауза
          </TooltipTrigger>
          <TooltipContent>Доработает текущие задания, новых не возьмёт</TooltipContent>
        </Tooltip>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={`Ещё действия с ${a.name}`} />}>
          <Ellipsis aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem disabled={a.status === "DISABLED"} onClick={() => act(a.id, "disable")}>
            <Power aria-hidden />
            Отключить
          </DropdownMenuItem>
          <DropdownMenuItem disabled={a.connection !== "ONLINE"} onClick={() => act(a.id, "rotate-key")}>
            <KeyRound aria-hidden />
            Сменить ключ
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={revoke}>
            <ShieldOff aria-hidden />
            Отозвать доступ
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function AgentsPage({ agentId }: { agentId?: string }) {
  const queryClient = useQueryClient();
  const now = useNow();
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/agents"), refetchInterval: POLL_MS });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: AgentAction }) =>
      action === "delete" ? api(`/agents/${id}`, { method: "DELETE" }) : api(`/agents/${id}/${action}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: notifyError("Действие с агентом"),
  });
  const run = (id: string, action: AgentAction) => act.mutate({ id, action });
  const invite = useMutation({ mutationFn: () => api<Invite>("/agents/enrollments", { method: "POST" }), onError: notifyError("Приглашение") });

  const c = columns<Agent>();
  const cols: Column<Agent>[] = [
    c.accessor("name", {
      header: "Агент",
      cell: (i) => (
        <div className="grid">
          <Link to="/agents/$agentId" params={{ agentId: i.row.original.id }} className="font-medium hover:underline">
            {i.getValue()}
          </Link>
          {i.row.original.model && (
            <span data-testid="agent-model" className="text-xs text-muted-foreground">
              {i.row.original.model}
            </span>
          )}
        </div>
      ),
    }),
    c.accessor("status", { header: "Статус", cell: (i) => <StatusBadge status={i.getValue()} data-testid="agent-status" /> }),
    c.accessor("connection", { header: "Связь", cell: (i) => <StatusBadge status={i.getValue()} data-testid="agent-connection" /> }),
    c.accessor("lastSeenAt", { header: "Сигнал", cell: (i) => <span className="text-muted-foreground tabular-nums">{ago(i.getValue(), now)}</span> }),
    c.accessor((a) => a.heartbeat?.lsAvailable, { id: "ls", header: "LS", cell: (i) => <LsStatus agent={i.row.original} /> }),
    c.accessor((a) => a.heartbeat?.power?.batteryPercent ?? 101, {
      id: "power",
      header: "Питание",
      cell: (i) => <PowerIndicator power={i.row.original.heartbeat?.power} />,
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
    c.accessor("agentVersion", { header: "Версия", cell: (i) => <AgentVersion agent={i.row.original} /> }),
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
            Подключить Mac
          </Button>
        }
      />
      {invite.data && <ConnectMacDialog key={invite.data.id} invite={invite.data} onClose={() => invite.reset()} />}
      {agents.data?.length === 0 && <EmptyState icon={Monitor} title="Агентов пока нет" description="Нажмите «Подключить Mac»: появится одна команда для Терминала нового Mac." />}
      {!!agents.data?.length && <DataTable id="agents" data={agents.data} columns={cols} rowTestId={(a) => `agent-${a.name}`} />}
      <AgentSheet id={agentId} />
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, ListChecks, MousePointerClick, Play, Send, Square } from "lucide-react";
import { useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { notifyDone, notifyError } from "@/lib/notify";
import { cn } from "@/lib/utils";

interface ClickerState {
  version: string | null;
  sha256: string | null;
  inputRows: number;
  outputRows: number;
  run: { running: boolean; startedAt: string | null; finishedAt: string | null; ok: boolean | null };
  stage: { node: string; errors: string[]; ageSeconds: number | null; url: string } | null;
}
interface ClickerMac {
  agentId: string;
  name: string;
  model: string | null;
  connection: string;
  state: ClickerState;
  sent: number;
  processed: number;
}
interface Overview {
  build: { sha256: string; sizeBytes: number; uploadedAt: string; uploadedBy: string | null } | null;
  macs: ClickerMac[];
  unsent: number;
}
type Flow = { key: string; label: string; aliases: string[]; action: string; fields: string[] }[];

const POLL_MS = 2000;
/** The engine's heartbeat counts as live for two minutes, as its own panel had it. */
const LIVE_SECONDS = 120;

/** The step of the flow the engine reports (state.json node), by its markers. */
const stepOf = (flow: Flow, node: string) => {
  const s = node.toLowerCase();
  return flow.findIndex((f) => f.aliases.some((a) => s.includes(a.toLowerCase())));
};

function FlowMap({ flow, at }: { flow: Flow; at: number }) {
  if (flow.length === 0) return null;
  return (
    <ol className="flex flex-wrap gap-1" aria-label="Этапы">
      {flow.map((f, i) => (
        <li
          key={f.key}
          title={[f.action, ...f.fields].filter(Boolean).join("\n")}
          aria-current={i === at ? "step" : undefined}
          className={cn("rounded-sm px-1.5 py-0.5 text-[11px]", i === at ? "bg-primary text-primary-foreground" : i < at ? "bg-ok-soft text-ok" : "bg-muted text-muted-foreground")}
        >
          {f.label}
        </li>
      ))}
    </ol>
  );
}

function MacCard({ mac, build, flow, selected, onSelect, onPlan }: { mac: ClickerMac; build: Overview["build"]; flow: Flow; selected: boolean; onSelect: () => void; onPlan: () => void }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ls-clicker"] });
  const run = useMutation({ mutationFn: () => api(`/agents/${mac.agentId}/ls-clicker/runs`, { method: "POST" }), onSuccess: refresh, onError: notifyError(`Запуск на ${mac.name}`) });
  const stop = useMutation({ mutationFn: () => api(`/agents/${mac.agentId}/ls-clicker/stop`, { method: "POST" }), onSuccess: refresh, onError: notifyError(`Остановка на ${mac.name}`) });
  const s = mac.state;
  const online = mac.connection === "ONLINE";
  const pending = s.inputRows - s.outputRows;
  const result = s.run.running ? "RUNNING" : s.run.ok === true ? "SUCCEEDED" : s.run.ok === false ? "FAILED" : null;
  const at = s.stage ? stepOf(flow, s.stage.node) : -1;
  const live = s.stage?.ageSeconds !== null && s.stage?.ageSeconds !== undefined && s.stage.ageSeconds < LIVE_SECONDS;
  const outdated = !!build && s.sha256 !== build.sha256;
  return (
    <section data-testid={`clicker-${mac.name}`} aria-label={mac.name} className={cn("grid content-start gap-3 rounded-lg border bg-card p-4", selected && "ring-2 ring-ring")}>
      <div className="flex items-start gap-2">
        <button type="button" onClick={onSelect} className="grid min-w-0 flex-1 text-left">
          <span className="truncate font-medium hover:underline">{mac.name}</span>
          <span className="truncate text-xs text-muted-foreground">{mac.model ?? "—"}</span>
        </button>
        <StatusBadge status={mac.connection} />
      </div>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Версия</dt>
          <dd data-testid="clicker-version" className="truncate font-mono">
            {s.version ?? (s.sha256 ? s.sha256.slice(0, 12) : "не установлен")}
            {outdated && <span className="ml-1 rounded-sm bg-wait-soft px-1 font-sans text-[10px] text-wait">обновляется</span>}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Строки</dt>
          <dd data-testid="clicker-rows" className="tabular-nums">
            {s.outputRows} из {s.inputRows} обработано{pending > 0 && `, в очереди ${pending}`}
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {result ? <StatusBadge status={result} data-testid="clicker-run" /> : <span data-testid="clicker-run" className="text-muted-foreground">запусков не было</span>}
        <span className="text-muted-foreground tabular-nums">{s.run.running ? `с ${dateTime(s.run.startedAt!)}` : s.run.finishedAt ? `закончил ${dateTime(s.run.finishedAt)}` : ""}</span>
      </div>
      {s.stage && (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className={cn("size-2 rounded-full", live ? "bg-ok" : "bg-muted-foreground/40")} aria-hidden />
            <span data-testid="clicker-stage">{at >= 0 ? flow[at]!.label : s.stage.node || "—"}</span>
            {s.stage.ageSeconds !== null && <span className="text-muted-foreground">{s.stage.ageSeconds} с назад</span>}
          </div>
          <FlowMap flow={flow} at={at} />
          {s.stage.errors.length > 0 && <p className="text-xs text-fail">{s.stage.errors.join("; ")}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {s.run.running ? (
          <Button size="sm" variant="outline" disabled={!online || stop.isPending} onClick={() => stop.mutate()}>
            <Square aria-hidden />
            Остановить
          </Button>
        ) : (
          <Button size="sm" disabled={!online || pending <= 0 || !s.sha256 || run.isPending} onClick={() => run.mutate()}>
            <Play aria-hidden />
            Запустить строку
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onSelect}>
          Журнал
        </Button>
        <Button size="sm" variant="ghost" disabled={!online || !s.sha256} onClick={onPlan}>
          <ListChecks aria-hidden />
          План ввода
        </Button>
      </div>
    </section>
  );
}

function Log({ mac }: { mac: ClickerMac }) {
  const log = useQuery({ queryKey: ["ls-clicker", "log", mac.agentId], queryFn: () => api<{ lines: string[] }>(`/agents/${mac.agentId}/ls-clicker/log`), refetchInterval: POLL_MS, retry: false });
  return (
    <section aria-label={`Журнал ${mac.name}`} className="rounded-lg border bg-card">
      <h2 className="border-b px-4 py-2 text-sm font-medium">Журнал: {mac.name}</h2>
      <pre data-testid="clicker-log" className="max-h-96 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap">
        {log.error ? (log.error as Error).message : log.data?.lines.join("\n") || "Журнал пока пуст."}
      </pre>
    </section>
  );
}

/** The next row's input plan (ls-clicker --plan): values go to the operator's screen only. */
function PlanDialog({ mac, onClose }: { mac: ClickerMac; onClose: () => void }) {
  const plan = useQuery({ queryKey: ["ls-clicker", "plan", mac.agentId], queryFn: () => api<{ plan: unknown }>(`/agents/${mac.agentId}/ls-clicker/plan`, { timeoutMs: 50_000 }), retry: false });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>План ввода: {mac.name}</DialogTitle>
          <DialogDescription>Какие значения LS Clicker введёт в какие поля для следующей строки.</DialogDescription>
        </DialogHeader>
        <pre data-testid="clicker-plan" className="max-h-[60vh] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap">
          {plan.isPending ? "Готовим план…" : plan.error ? (plan.error as Error).message : JSON.stringify(plan.data?.plan, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

/**
 * LS Clicker without a panel of its own (REQ-LSC-004): its build rolls out to every Mac from here,
 * rows come from «Конвейер» → «Таблица», runs start on one Mac or on all of them.
 */
export function LsClickerPage() {
  const queryClient = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<ClickerMac | null>(null);
  const overview = useQuery({ queryKey: ["ls-clicker"], queryFn: () => api<Overview>("/ls-clicker"), refetchInterval: POLL_MS });
  const flow = useQuery({ queryKey: ["ls-clicker-flow"], queryFn: () => api<Flow>("/ls-clicker/flow") });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ls-clicker"] });
  const runAll = useMutation({
    mutationFn: () => api<{ started: string[]; skipped: { name: string; reason: string }[] }>("/ls-clicker/runs", { method: "POST", timeoutMs: 60_000 }),
    onSuccess: (r) => {
      void refresh();
      notifyDone(r.started.length ? `Запущено: ${r.started.join(", ")}` : "Ничего не запущено", r.skipped.map((s) => `${s.name}: ${s.reason}`).join("; ") || undefined);
    },
    onError: notifyError("Запуск на всех"),
  });
  const send = useMutation({
    mutationFn: () => api<{ sent: { name: string; rows: number }[]; failed: { name: string; message: string }[] }>("/ls-clicker/distribute", { method: "POST", body: "{}", timeoutMs: 60_000 }),
    onSuccess: (r) => {
      void refresh();
      notifyDone(r.sent.length ? `Отправлено: ${r.sent.map((s) => `${s.name} — ${s.rows}`).join(", ")}` : "Строки не отправлены", r.failed.map((f) => `${f.name}: ${f.message}`).join("; ") || undefined);
    },
    onError: notifyError("Отправка строк"),
  });
  const upload = useMutation({
    mutationFn: async (f: File) => api<{ sha256: string }>("/ls-clicker/builds", { method: "POST", body: await f.arrayBuffer(), headers: { "content-type": "application/octet-stream" }, timeoutMs: 60_000 }),
    onSuccess: (b) => {
      void refresh();
      notifyDone("Сборка загружена", `Раскатывается на все Mac: ${b.sha256.slice(0, 12)}`);
    },
    onError: notifyError("Загрузка сборки"),
  });
  const data = overview.data;
  const macs = data?.macs ?? [];
  const chosen = macs.find((m) => m.agentId === selected) ?? macs[0];
  const updated = data?.build ? macs.filter((m) => m.state.sha256 === data.build!.sha256).length : 0;

  return (
    <>
      <PageHeader
        title="LS Clicker"
        description="Движок регистрации на всех Mac. Сборка раскатывается отсюда сама, строки берутся из «Конвейер» → «Таблица», запуск — на одном Mac или на всех."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!data?.unsent || send.isPending} onClick={() => send.mutate()}>
              <Send aria-hidden />
              Отправить строки{data?.unsent ? ` (${data.unsent})` : ""}
            </Button>
            <Button disabled={macs.length === 0 || runAll.isPending} onClick={() => runAll.mutate()}>
              <Play aria-hidden />
              Запустить на всех
            </Button>
          </div>
        }
      />
      <section aria-label="Сборка" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-sm">
        <span>
          Сборка:{" "}
          {data?.build ? (
            <>
              <span data-testid="clicker-build" className="font-mono text-xs">
                {data.build.sha256.slice(0, 12)}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {dateTime(data.build.uploadedAt)}
                {data.build.uploadedBy && `, ${data.build.uploadedBy}`} · обновлено Mac: {updated} из {macs.length}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">не загружена</span>
          )}
        </span>
        <input
          ref={file}
          type="file"
          className="sr-only"
          aria-label="Файл сборки ls-clicker"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
        <Button size="sm" variant="outline" className="ml-auto" disabled={upload.isPending} onClick={() => file.current?.click()}>
          <FileUp aria-hidden />
          Загрузить сборку
        </Button>
      </section>
      {data && macs.length === 0 && <EmptyState icon={MousePointerClick} title="Нет Mac с LS Clicker" description="Агенты сообщают о LS Clicker, когда на Mac включён его каталог (по умолчанию ~/Developer/ls-clicker)." />}
      {macs.length > 0 && (
        <div className="grid gap-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {macs.map((m) => (
              <MacCard key={m.agentId} mac={m} build={data!.build} flow={flow.data ?? []} selected={m.agentId === chosen?.agentId} onSelect={() => setSelected(m.agentId)} onPlan={() => setPlan(m)} />
            ))}
          </div>
          {chosen && <Log key={chosen.agentId} mac={chosen} />}
        </div>
      )}
      {plan && <PlanDialog mac={plan} onClose={() => setPlan(null)} />}
    </>
  );
}

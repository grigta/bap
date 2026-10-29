import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileUp, ListChecks, RotateCcw, ScrollText, Square } from "lucide-react";
import { useRef, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  /** Ticked: the Mac takes ready table rows by itself. */
  auto: boolean;
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

/** One Mac on one line: what it runs, where it is, and its buttons. */
function MacRow({ mac, build, flow, selected, onSelect, onPlan }: { mac: ClickerMac; build: Overview["build"]; flow: Flow; selected: boolean; onSelect: () => void; onPlan: () => void }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ls-clicker"] });
  const run = useMutation({ mutationFn: () => api(`/agents/${mac.agentId}/ls-clicker/runs`, { method: "POST", body: JSON.stringify({ retry: true }) }), onSuccess: refresh, onError: notifyError(`Повтор на ${mac.name}`) });
  const stop = useMutation({ mutationFn: () => api(`/agents/${mac.agentId}/ls-clicker/stop`, { method: "POST" }), onSuccess: refresh, onError: notifyError(`Остановка на ${mac.name}`) });
  const auto = useMutation({
    mutationFn: (enabled: boolean) => api(`/agents/${mac.agentId}/ls-clicker/auto`, { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: refresh,
    onError: notifyError(`Прогоны на ${mac.name}`),
  });
  const s = mac.state;
  const online = mac.connection === "ONLINE";
  const pending = s.inputRows - s.outputRows;
  const result = s.run.running ? "RUNNING" : s.run.ok === true ? "SUCCEEDED" : s.run.ok === false ? "FAILED" : null;
  const at = s.stage ? stepOf(flow, s.stage.node) : -1;
  const live = s.stage?.ageSeconds !== null && s.stage?.ageSeconds !== undefined && s.stage.ageSeconds < LIVE_SECONDS;
  const outdated = !!build && s.sha256 !== build.sha256;
  return (
    <li data-testid={`clicker-${mac.name}`} aria-label={mac.name} className={cn("grid items-center gap-x-4 gap-y-1 px-3 py-2 text-xs sm:grid-cols-[minmax(9rem,1.2fr)_minmax(7rem,1fr)_minmax(8rem,1fr)_minmax(9rem,1.3fr)_minmax(10rem,1.5fr)_auto]", selected && "bg-accent/60")}>
      <button type="button" onClick={onSelect} aria-expanded={selected} className="grid min-w-0 text-left">
        <span className="flex items-center gap-1.5 truncate text-sm font-medium hover:underline">
          <span className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-ok" : "bg-muted-foreground/40")} aria-label={online ? "на связи" : "не на связи"} role="img" />
          {mac.name}
        </span>
        <span className="truncate text-muted-foreground">{mac.model ?? "—"}</span>
      </button>
      <span data-testid="clicker-version" className="truncate font-mono">
        {s.version ?? (s.sha256 ? s.sha256.slice(0, 12) : "не установлен")}
        {outdated && <span className="ml-1 rounded-sm bg-wait-soft px-1 font-sans text-[10px] text-wait">обновляется</span>}
      </span>
      <span data-testid="clicker-rows" className="tabular-nums">
        {s.outputRows} из {s.inputRows} обработано{pending > 0 && `, в очереди ${pending}`}
      </span>
      <span className="flex items-center gap-1.5">
        {result ? <StatusBadge status={result} data-testid="clicker-run" /> : <span data-testid="clicker-run" className="text-muted-foreground">запусков не было</span>}
        <span className="truncate text-muted-foreground tabular-nums">{s.run.finishedAt && !s.run.running ? dateTime(s.run.finishedAt) : ""}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {s.stage ? (
          <>
            <span className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-ok" : "bg-muted-foreground/40")} aria-hidden />
            <span data-testid="clicker-stage" className="truncate">
              {at >= 0 ? flow[at]!.label : s.stage.node || "—"}
            </span>
            {at >= 0 && <span className="text-muted-foreground tabular-nums">{at + 1}/{flow.length}</span>}
            {s.stage.errors.length > 0 && <span className="text-fail" title={s.stage.errors.join("; ")}>· ошибки: {s.stage.errors.length}</span>}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </span>
      <span className="flex justify-end gap-1">
        {/* Ticked Macs take ready rows by themselves; after a failed run the operator repeats it by hand. */}
        <label className="mr-1 flex items-center gap-1.5" title="Брать готовые строки таблицы на этом Mac">
          <Checkbox checked={mac.auto} disabled={auto.isPending} onCheckedChange={(v) => auto.mutate(!!v)} aria-label={`Использовать ${mac.name} для прогонов`} />
          <span className="text-muted-foreground">прогоны</span>
        </label>
        {s.run.running && (
          <Button size="icon-xs" variant="outline" aria-label="Остановить" title="Остановить" disabled={!online || stop.isPending} onClick={() => stop.mutate()}>
            <Square aria-hidden />
          </Button>
        )}
        {!s.run.running && s.run.ok === false && (
          <Button size="icon-xs" variant="outline" aria-label="Повторить" title="Прогон упал: автозапуск на этом Mac ждёт. Повторить строку" disabled={!online || !s.sha256 || run.isPending} onClick={() => run.mutate()}>
            <RotateCcw aria-hidden />
          </Button>
        )}
        <Button size="icon-xs" variant="ghost" aria-label="Журнал" title="Журнал" aria-pressed={selected} onClick={onSelect}>
          <ScrollText aria-hidden />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="План ввода" title="План ввода" disabled={!online || !s.sha256} onClick={onPlan}>
          <ListChecks aria-hidden />
        </Button>
      </span>
    </li>
  );
}

/** The chosen Mac: where it is on the flow, its errors and the engine's log. */
function MacDetails({ mac, flow }: { mac: ClickerMac; flow: Flow }) {
  const log = useQuery({ queryKey: ["ls-clicker", "log", mac.agentId], queryFn: () => api<{ lines: string[] }>(`/agents/${mac.agentId}/ls-clicker/log`), refetchInterval: POLL_MS, retry: false });
  const s = mac.state;
  return (
    <section data-testid="clicker-details" aria-label={`Журнал ${mac.name}`} className="grid gap-2 border-t p-3">
      {s.stage && <FlowMap flow={flow} at={stepOf(flow, s.stage.node)} />}
      {s.stage && s.stage.errors.length > 0 && <p className="text-xs text-fail">{s.stage.errors.join("; ")}</p>}
      <pre data-testid="clicker-log" className="max-h-56 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
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
 * LS Clicker on «Конвейер» (REQ-LSC-004): the build and its rollout, one line per Mac with its run and
 * stage, run on one or all; the chosen Mac's flow and log open below. Rows come from «Таблица» below.
 */
export function LsClickerPanel() {
  const queryClient = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [plan, setPlan] = useState<ClickerMac | null>(null);
  const overview = useQuery({ queryKey: ["ls-clicker"], queryFn: () => api<Overview>("/ls-clicker"), refetchInterval: POLL_MS });
  const flow = useQuery({ queryKey: ["ls-clicker-flow"], queryFn: () => api<Flow>("/ls-clicker/flow") });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ls-clicker"] });
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
  const chosen = macs.find((m) => m.agentId === selected);
  const updated = data?.build ? macs.filter((m) => m.state.sha256 === data.build!.sha256).length : 0;

  return (
    <section aria-label="LS Clicker" className="mb-4 rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2 text-xs">
        <span className="text-sm font-medium">LS Clicker</span>
        <span className="text-muted-foreground">
          сборка{" "}
          {data?.build ? (
            <>
              <span data-testid="clicker-build" className="font-mono text-foreground">
                {data.build.sha256.slice(0, 12)}
              </span>{" "}
              · обновлено Mac: {updated} из {macs.length}
            </>
          ) : (
            "не загружена"
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
        <Button size="xs" variant="ghost" disabled={upload.isPending} onClick={() => file.current?.click()}>
          <FileUp aria-hidden />
          Загрузить сборку
        </Button>
        <span data-testid="clicker-unsent" className="ml-auto text-muted-foreground">
          Готовы к прогону: {data?.unsent ?? 0} · прогоны на Mac: {macs.filter((m) => m.auto).length} из {macs.length}
        </span>
      </div>
      {data && macs.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">Нет Mac с LS Clicker: агент сообщает о нём, когда на Mac есть каталог ~/Developer/ls-clicker.</p>}
      {macs.length > 0 && (
        <ul className="divide-y">
          {macs.map((m) => (
            <MacRow key={m.agentId} mac={m} build={data!.build} flow={flow.data ?? []} selected={m.agentId === chosen?.agentId} onSelect={() => setSelected(m.agentId === selected ? null : m.agentId)} onPlan={() => setPlan(m)} />
          ))}
        </ul>
      )}
      {chosen && <MacDetails key={chosen.agentId} mac={chosen} flow={flow.data ?? []} />}
      {plan && <PlanDialog mac={plan} onClose={() => setPlan(null)} />}
    </section>
  );
}

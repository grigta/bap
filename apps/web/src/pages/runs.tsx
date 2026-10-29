import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Flag, PlayCircle, Play, Plus, RotateCcw, Square, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { type Column, DataTable, columns } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/layout/app-shell";
import { HttpError, api } from "@/lib/api";
import { seconds, shortId, time } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import { CANCELLABLE_RUN, FINAL_RUN, type ListedRun, type PendingConfirmation, type Profile, RUN_STATUSES, type Run, type RunDetail, type RunStatus, type Step, type StepResolution } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LsClickerPanel } from "./ls-clicker";
import { PipelineTable } from "./pipeline-table";

const MARK = { passed: "✓", failed: "✗", unverified: "?" } as const;
const MARK_TONE = { passed: "bg-ok-soft text-ok", failed: "bg-fail-soft text-fail", unverified: "bg-wait-soft text-wait" } as const;
/** How a recipe step found its target: by fingerprint, healed after a redesign, confirmed or recorded. */
const RESOLUTION: Record<StepResolution, [string, string]> = {
  found: ["найден", "bg-ok-soft text-ok"],
  healed: ["вылечен", "bg-busy-soft text-busy"],
  confirmed: ["подтверждён", "bg-wait-soft text-wait"],
  recorded: ["записан", "bg-idle-soft text-idle"],
};
const runTitle = (r: Run) => (r.kind === "farm" ? `Прогрев: ${(r.input as { query?: string }).query ?? ""}` : `${r.scenarioId}@${r.scenarioVersion ?? "запись"}`);

/** Starting a code scenario by hand: folded into one button (next to the filter) until the operator needs it. */
function NewRunForm({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const queryClient = useQueryClient();
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => api<{ id: string; versions: { version: string }[] }[]>("/scenarios") });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/profiles"), refetchInterval: 2000 });
  const [scenario, setScenario] = useState("");
  const [profileId, setProfileId] = useState("");
  const [input, setInput] = useState('{\n  "baseUrl": "http://127.0.0.1:4310"\n}');
  const [timeoutMs, setTimeoutMs] = useState(120_000);
  // One key per attempt: a double submit replays instead of creating a second run.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [inputError, setInputError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: object) => api<{ runId: string }>("/runs", { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": idempotencyKey } }),
    onSuccess: ({ runId }) => {
      setIdempotencyKey(crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      onCreated(runId);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return setInputError("Input — не JSON");
    }
    setInputError(null);
    const [scenarioId, scenarioVersion] = scenario.split("@");
    create.mutate({ scenarioId, scenarioVersion, profileId, input: parsed, timeoutMs });
  };
  return (
    <form onSubmit={submit} className="mb-6 rounded-lg border bg-card p-4" aria-labelledby="new-run-title">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="new-run-title" className="text-sm font-medium">
          Новый запуск
        </h2>
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          Свернуть
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_2fr_9rem]">
        <div className="grid content-start gap-1.5">
          <Label htmlFor="run-scenario">Сценарий</Label>
          <NativeSelect id="run-scenario" value={scenario} onChange={(e) => setScenario(e.target.value)} required className="w-full">
            <NativeSelectOption value="">Выберите</NativeSelectOption>
            {scenarios.data?.flatMap((s) => s.versions.map((v) => <NativeSelectOption key={`${s.id}@${v.version}`}>{`${s.id}@${v.version}`}</NativeSelectOption>))}
          </NativeSelect>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="run-profile">Профиль</Label>
          <NativeSelect id="run-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} required className="w-full">
            <NativeSelectOption value="">Выберите</NativeSelectOption>
            {profiles.data?.map((p) => (
              <NativeSelectOption key={p.id} value={p.id} disabled={!p.assignable}>
                {p.assignable ? p.name : `${p.name} (${p.status})`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="run-input">Input (JSON)</Label>
          <Textarea id="run-input" value={input} onChange={(e) => setInput(e.target.value)} rows={3} className="min-h-0 font-mono text-xs" />
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="run-timeout">timeoutMs</Label>
          <Input id="run-timeout" type="number" min={1000} step={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} className="tabular-nums" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={create.isPending}>
          <Play aria-hidden />
          Запустить
        </Button>
        {inputError && (
          <p role="alert" className="text-sm text-fail">
            {inputError}
          </p>
        )}
        {create.error instanceof HttpError && (
          <p role="alert" className="text-sm text-fail">
            {create.error.code ?? `HTTP ${create.error.status}`}: {create.error.message}
          </p>
        )}
      </div>
    </form>
  );
}

export function useRunActions() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const refresh = () => queryClient.invalidateQueries();
  const cancel = useMutation({ mutationFn: (id: string) => api(`/runs/${id}/cancel`, { method: "POST" }), onSettled: refresh, onError: notifyError("Отмена задания") });
  const resume = useMutation({
    mutationFn: (id: string) => api(`/runs/${id}/resume`, { method: "POST", body: JSON.stringify({ mode: "safe-checkpoint", operatorConfirmed: true }) }),
    onSettled: refresh,
    onError: notifyError("Resume"),
  });
  return {
    cancel: (id: string) => cancel.mutate(id),
    // Resuming is the operator's call: confirm that the run and the site were checked.
    resume: async (id: string) => {
      if (
        await confirm({
          title: "Продолжить задание с последней контрольной точки?",
          description: "Шаг, изменявший данные на сайте, будет проверен, а не повторён. Перед продолжением убедитесь, что состояние сайта вам понятно.",
          action: "Продолжить",
        })
      )
        resume.mutate(id);
    },
  };
}

/** The run's steps as a strip of frames: what the browser showed after each step. */
function Filmstrip({ run, steps }: { run: RunDetail; steps: Step[] }) {
  const [open, setOpen] = useState<Step | null>(null);
  const src = (s: Step) => `/api/v1/runs/${run.id}/artifacts/${s.screenshotArtifactId}/content`;
  return (
    <>
      <ol className="flex snap-x gap-3 overflow-x-auto pb-2" aria-label="Шаги">
        {steps.map((s) => {
          const checkpoint = run.checkpoints.some((c) => c.sequence === s.sequence);
          return (
            <li key={s.sequence} data-testid={`step-${s.stepId}`} className={cn("w-56 shrink-0 snap-start overflow-hidden rounded-md border bg-background", s.status !== "passed" && "border-fail/40")}>
              <button type="button" disabled={!s.screenshotArtifactId} onClick={() => setOpen(s)} className="block aspect-[16/10] w-full overflow-hidden border-b bg-muted disabled:cursor-default" aria-label={`Скриншот шага ${s.stepId}`}>
                {s.screenshotArtifactId ? (
                  <img src={src(s)} alt={s.stepId} className="size-full object-cover object-top" loading="lazy" />
                ) : (
                  <span className="grid size-full place-items-center text-xs text-muted-foreground">без скриншота</span>
                )}
              </button>
              <div className="grid gap-1 p-2 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className={cn("grid size-4 shrink-0 place-items-center rounded-sm text-[11px] font-semibold", MARK_TONE[s.status])}>{MARK[s.status]}</span>
                  <span className="truncate font-medium" title={s.intent ?? s.stepId}>
                    {s.sequence}. {s.intent ?? s.stepId}
                  </span>
                  <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{s.durationMs} мс</span>
                </div>
                {(s.mutating || checkpoint || s.resolution) && (
                  <div className="flex flex-wrap gap-1">
                    {s.resolution && (
                      <span data-testid="step-resolution" className={cn("rounded-sm px-1 text-[10px]", RESOLUTION[s.resolution][1])} title={s.note ?? undefined}>
                        {RESOLUTION[s.resolution][0]}
                      </span>
                    )}
                    {s.mutating && <span className="rounded-sm bg-wait-soft px-1 text-[10px] text-wait">mutating</span>}
                    {checkpoint && (
                      <span className="inline-flex items-center gap-0.5 rounded-sm bg-busy-soft px-1 text-[10px] text-busy">
                        <Flag className="size-2.5" aria-hidden />
                        checkpoint
                      </span>
                    )}
                  </div>
                )}
                {/* Why it was healed, what proved a step that changed data (REQ-DOM-012, REQ-DOM-014), where a warm-up went (REQ-FARM-001). */}
                {s.note && (s.resolution === "healed" || s.mutating || run.kind === "farm") && (
                  <p data-testid="step-note" className="text-[11px] text-muted-foreground">
                    {s.note}
                  </p>
                )}
                {s.error && <pre className="max-h-24 overflow-auto rounded-sm bg-fail-soft p-1.5 font-mono text-[10px] whitespace-pre-wrap text-fail">{s.error}</pre>}
              </div>
            </li>
          );
        })}
      </ol>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-5xl">
          <DialogTitle>
            Шаг {open?.sequence}. {open?.intent ?? open?.stepId}
          </DialogTitle>
          {open && <img src={src(open)} alt={`Скриншот шага ${open.stepId}`} className="w-full rounded-md border" />}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A recording waits before an action that changes data on the site: the operator decides (REQ-DOM-008). */
function Confirmation({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const pending = useQuery({ queryKey: ["confirmation", runId], queryFn: () => api<{ pending: PendingConfirmation | null }>(`/runs/${runId}/confirmation`), refetchInterval: 1000 });
  const decide = useMutation({
    mutationFn: (decision: "confirm" | "reject") => api(`/runs/${runId}/confirmation`, { method: "POST", body: JSON.stringify({ decision }) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["confirmation", runId] }),
    onError: notifyError("Подтверждение"),
  });
  const p = pending.data?.pending;
  if (!p) return null;
  return (
    <div role="region" aria-label="Ждёт подтверждения" data-testid="confirmation" className="grid gap-3 rounded-lg border border-wait/40 bg-wait-soft p-3 sm:grid-cols-[16rem_1fr]">
      {p.screenshotArtifactId && <img src={`/api/v1/runs/${runId}/artifacts/${p.screenshotArtifactId}/content`} alt="Страница перед действием" className="w-full rounded-md border bg-background" />}
      <div className="grid content-start gap-2">
        <p className="text-sm font-medium text-wait">Ждёт подтверждения</p>
        <p className="text-sm">
          Следующее действие меняет данные на сайте: <b>{p.intent}</b>
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("confirm")}>
            <Check aria-hidden />
            Подтвердить
          </Button>
          <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate("reject")}>
            <X aria-hidden />
            Отклонить
          </Button>
        </div>
      </div>
    </div>
  );
}

function RunPanel({ id }: { id: string }) {
  const navigate = useNavigate();
  const actions = useRunActions();
  const run = useQuery({ queryKey: ["run", id], queryFn: () => api<RunDetail>(`/runs/${id}`), refetchInterval: (q) => (q.state.data && FINAL_RUN.includes(q.state.data.status) ? false : 1000) });
  const steps = useQuery({
    // The status is part of the key: when the run ends, the steps are fetched once more, so the
    // last steps are not lost to a poll that ran just before they arrived.
    queryKey: ["run-steps", id, run.data?.status],
    queryFn: () => api<Step[]>(`/runs/${id}/steps`),
    refetchInterval: run.data && FINAL_RUN.includes(run.data.status) ? false : 1000,
  });
  if (run.isError) return <p className="mb-6 text-sm text-fail">Задание {shortId(id)} не найдено.</p>;
  if (!run.data) return null;
  const r = run.data;
  return (
    <section data-testid="run-detail" className="mb-6 rounded-lg border bg-card">
      <header className="flex flex-wrap items-start gap-3 border-b p-4">
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {runTitle(r)} <StatusBadge status={r.status} data-testid="run-status" />
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            <span className="font-mono">{r.id}</span>, создано {time(r.createdAt)}
            {r.finishedAt && `, завершено ${time(r.finishedAt)}`}
            {r.startedAt && r.finishedAt && ` за ${seconds(r.startedAt, r.finishedAt)}`}
          </p>
        </div>
        <div className="flex gap-2">
          {CANCELLABLE_RUN.includes(r.status) && (
            <Button variant="outline" size="sm" onClick={() => actions.cancel(r.id)}>
              <Square aria-hidden />
              Cancel
            </Button>
          )}
          {r.status === "RECOVERY_PENDING" && (
            <Button size="sm" onClick={() => actions.resume(r.id)}>
              <RotateCcw aria-hidden />
              Resume
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Закрыть" onClick={() => navigate({ to: "/runs", search: (s) => s })}>
            <X />
          </Button>
        </div>
      </header>
      <div className="grid gap-4 p-4">
        {r.kind === "record" && !FINAL_RUN.includes(r.status) && <Confirmation runId={r.id} />}
        {r.errorCode && (
          <p data-testid="run-error" className="rounded-md bg-fail-soft px-3 py-2 font-mono text-xs break-words text-fail">
            {r.errorCode}: {r.errorMessage}
          </p>
        )}
        {steps.data && steps.data.length > 0 ? <Filmstrip run={r} steps={steps.data} /> : <p className="text-sm text-muted-foreground">Шагов пока нет.</p>}
        <details open className="group">
          <summary className="cursor-pointer text-sm font-medium">Журнал переходов</summary>
          <ol data-testid="transitions" className="mt-2 grid gap-1 border-l pl-4 text-xs">
            {r.transitions.map((t, i) => (
              <li key={i} className="relative">
                <span aria-hidden className="absolute top-1.5 -left-[19px] size-1.5 rounded-full bg-border" />
                <span className="text-muted-foreground tabular-nums">{time(t.at)}</span>{" "}
                <span className="font-mono">
                  {t.from ?? "∅"} → <b>{t.to}</b>
                </span>
                {t.reason && <span className="text-muted-foreground"> — {t.reason}</span>}
              </li>
            ))}
          </ol>
        </details>
      </div>
    </section>
  );
}

function waiting(r: Run) {
  if (r.status === "QUEUED") return `${Math.round((Date.now() - Date.parse(r.createdAt)) / 1000)} с${r.queueReason ? `, ${r.queueReason}` : ""}`;
  return r.startedAt ? seconds(r.createdAt, r.startedAt) : "—";
}

export function RunsPage({ runId, status, tab = "runs" }: { runId?: string; status?: RunStatus; tab?: "runs" | "table" }) {
  const navigate = useNavigate();
  const runs = useQuery({ queryKey: ["runs", status ?? ""], queryFn: () => api<ListedRun[]>(`/runs${status ? `?status=${status}` : ""}`), refetchInterval: 2000 });

  const c = columns<ListedRun>();
  const cols: Column<ListedRun>[] = [
    c.accessor("id", {
      header: "Задание",
      enableSorting: false,
      cell: (i) => (
        <Link to="/runs/$runId" params={{ runId: i.getValue() }} search={(s) => s} className="font-mono text-xs hover:underline" aria-current={i.getValue() === runId ? "true" : undefined}>
          {shortId(i.getValue())}
        </Link>
      ),
    }),
    c.accessor(runTitle, { id: "scenario", header: "Сценарий" }),
    c.accessor("status", { header: "Статус", cell: (i) => <StatusBadge status={i.getValue()} data-testid="run-row-status" /> }),
    c.accessor("profileName", {
      header: "Профиль",
      cell: (i) => (
        <div className="grid justify-items-start gap-1">
          <span>{i.getValue()}</span>
          <StatusBadge status={i.row.original.profileStatus} data-testid="run-profile-status" />
        </div>
      ),
    }),
    c.accessor("agentName", {
      header: "Mac",
      cell: (i) => (
        <div className="grid">
          <span>{i.getValue()}</span>
          {i.row.original.agentModel && <span className="text-xs text-muted-foreground">{i.row.original.agentModel}</span>}
        </div>
      ),
    }),
    c.accessor((r) => r.profileLastError ?? "", {
      id: "profileError",
      header: "Ошибка профиля",
      enableSorting: false,
      cell: (i) =>
        i.getValue() ? (
          <span data-testid="run-profile-error" title={i.getValue()} className="line-clamp-2 max-w-64 text-xs text-fail">
            {i.getValue()}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    c.accessor("createdAt", { header: "Создано", cell: (i) => <span className="tabular-nums">{time(i.getValue())}</span> }),
    c.accessor((r) => (r.status === "QUEUED" ? -1 : r.startedAt ? Date.parse(r.startedAt) - Date.parse(r.createdAt) : 0), {
      id: "waiting",
      header: "Ожидание",
      cell: (i) => <span className="text-muted-foreground tabular-nums">{waiting(i.row.original)}</span>,
    }),
    c.accessor((r) => (r.startedAt && r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : -1), {
      id: "duration",
      header: "Длительность",
      cell: (i) => {
        const r = i.row.original;
        return <span className="tabular-nums">{r.startedAt && r.finishedAt ? seconds(r.startedAt, r.finishedAt) : "—"}</span>;
      },
    }),
  ];

  return (
    <>
      <PageHeader
        title="Конвейер"
        description="LS Clicker на всех Mac, ваша таблица строк и все проходы — на одной странице."
        actions={
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Что показать">
            {(["runs", "table"] as const).map((t) => (
              <Button key={t} size="sm" variant={tab === t ? "secondary" : "ghost"} aria-pressed={tab === t} onClick={() => navigate({ to: "/runs", search: t === "table" ? { tab: t } : {} })}>
                {t === "table" ? "Таблица" : "Проходы"}
              </Button>
            ))}
          </div>
        }
      />
      <LsClickerPanel />
      {tab === "table" ? <PipelineTable /> : <RunsList runId={runId} status={status} runs={runs.data} cols={cols} />}
    </>
  );
}

function RunsList({ runId, status, runs, cols }: { runId?: string; status?: RunStatus; runs: ListedRun[] | undefined; cols: Column<ListedRun>[] }) {
  const navigate = useNavigate();
  const [newRun, setNewRun] = useState(false);
  return (
    <>
      {newRun && <NewRunForm onCreated={(id) => navigate({ to: "/runs/$runId", params: { runId: id }, search: (s) => s })} onClose={() => setNewRun(false)} />}
      {runId && <RunPanel key={runId} id={runId} />}
      <div className="mb-3 flex items-center gap-2">
        <Label htmlFor="run-status-filter" className="text-sm text-muted-foreground">
          Статус
        </Label>
        <NativeSelect
          id="run-status-filter"
          size="sm"
          value={status ?? ""}
          onChange={(e) => navigate({ to: "/runs", search: { status: (e.target.value || undefined) as RunStatus | undefined } })}
          aria-label="Фильтр статуса"
          className="w-48"
        >
          <NativeSelectOption value="">все</NativeSelectOption>
          {RUN_STATUSES.map((s) => (
            <NativeSelectOption key={s}>{s}</NativeSelectOption>
          ))}
        </NativeSelect>
        {!newRun && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setNewRun(true)}>
            <Plus aria-hidden />
            Новый запуск
          </Button>
        )}
      </div>
      {runs?.length === 0 && <EmptyState icon={status ? Flag : PlayCircle} title={status ? `Заданий в статусе ${status} нет` : "Заданий пока нет"} description={status ? "Сбросьте фильтр, чтобы увидеть все." : "Строки LS Clicker запускаются выше, код-сценарии — кнопкой «Новый запуск»."} />}
      {!!runs?.length && <DataTable id="runs" data={runs} columns={cols} rowTestId={(r) => `run-${r.id}`} rowClassName={(r) => (r.id === runId ? "bg-accent/60" : undefined)} />}
    </>
  );
}

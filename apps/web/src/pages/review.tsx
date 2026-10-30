import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ChevronDown, ClipboardCheck, Download, MonitorPlay, RotateCcw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { EmptyState } from "@/components/empty-state";
import { RemoteBrowser } from "@/components/remote-browser";
import { StatusBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { dateTime, shortId } from "@/lib/format";
import { notifyDone, notifyError } from "@/lib/notify";
import type { FailureSnapshot, Issue, LsClickerFailure, ReviewQueue, RunDetail } from "@/lib/types";
import { useRunActions } from "./runs";

/** Elements shown before «показать все»: the page at the failure is usually long. */
const ELEMENTS_SHOWN = 40;

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground tabular-nums">{count}</span>
      </h2>
      {children}
    </section>
  );
}

const content = (runId: string, artifactId: string) => `/api/v1/runs/${runId}/artifacts/${artifactId}/content`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/** Everything known about the failure: for fixing the engine from a precise picture, not a guess. */
function FailureDetails({ issue }: { issue: Issue }) {
  const [all, setAll] = useState(false);
  const step = issue.failedStep;
  const failure = useQuery({
    queryKey: ["failure", issue.id],
    queryFn: () => api<FailureSnapshot>(`/runs/${issue.id}/artifacts/${step!.failureArtifactId}/content`),
    enabled: !!step?.failureArtifactId,
    staleTime: Infinity,
  });
  const run = useQuery({ queryKey: ["run", issue.id], queryFn: () => api<RunDetail>(`/runs/${issue.id}`), staleTime: Infinity });
  const elements = failure.data?.snapshot?.elements ?? [];
  return (
    <div data-testid="issue-details" className="grid gap-4 border-t p-3">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Сценарий">
          {issue.scenarioId}
          {issue.scenarioVersion && <span className="text-muted-foreground"> @{issue.scenarioVersion}</span>}
        </Field>
        <Field label="Mac">
          {issue.agentName}
          {issue.agentModel && <span className="block text-xs text-muted-foreground">{issue.agentModel}</span>}
        </Field>
        <Field label="Версия агента">
          <span className="font-mono text-xs">{issue.agentVersion ?? "—"}</span>
        </Field>
        <Field label="Остановился">{issue.finishedAt ? dateTime(issue.finishedAt) : "—"}</Field>
      </dl>
      {step ? (
        <dl className="grid gap-3">
          <Field label={`Шаг ${step.sequence}`}>
            <span className="font-medium">{step.intent ?? step.stepId}</span> <span className="font-mono text-xs text-muted-foreground">{step.stepId}</span>
          </Field>
          <Field label="Ошибка шага">
            <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">{step.error ?? "—"}</pre>
          </Field>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Задание остановилось вне шага: см. ошибку и журнал переходов.</p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {step?.screenshotArtifactId && <img src={content(issue.id, step.screenshotArtifactId)} alt={`Страница при ошибке шага ${step.stepId}`} className="w-full rounded-md border" loading="lazy" />}
        <div className="grid content-start gap-3">
          {failure.data ? (
            <>
              <dl className="grid gap-2">
                <Field label="Адрес">
                  <span data-testid="failure-url" className="font-mono text-xs">
                    {failure.data.url ?? "браузер недоступен"}
                  </span>
                </Field>
                <Field label="Заголовок">{failure.data.title || "—"}</Field>
              </dl>
              <div className="flex items-center justify-between">
                <h4 className="text-xs text-muted-foreground">Элементы страницы: {elements.length}</h4>
                <a href={content(issue.id, step!.failureArtifactId!)} download={`failure-${shortId(issue.id)}.json`} className={buttonVariants({ size: "xs", variant: "outline" })}>
                  <Download aria-hidden />
                  Скачать слепок
                </a>
              </div>
              {elements.length > 0 && (
                <div className="max-h-80 overflow-auto rounded-md border">
                  <table data-testid="failure-elements" className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 font-medium">Роль</th>
                        <th className="px-2 py-1 font-medium">Имя</th>
                        <th className="px-2 py-1 font-medium">Состояние</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(all ? elements : elements.slice(0, ELEMENTS_SHOWN)).map((e) => (
                        <tr key={e.ref} className={e.visible ? "border-t" : "border-t text-muted-foreground"}>
                          <td className="px-2 py-1 font-mono">{e.role}</td>
                          <td className="px-2 py-1">{e.name || e.text || e.label}</td>
                          <td className="px-2 py-1 text-muted-foreground">{[e.visible ? null : "скрыт", e.interactive ? null : "не активен", ...e.states].filter(Boolean).join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {elements.length > ELEMENTS_SHOWN && !all && (
                <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
                  Показать все {elements.length}
                </Button>
              )}
            </>
          ) : step?.failureArtifactId ? (
            <p className="text-sm text-muted-foreground">Загрузка слепка…</p>
          ) : (
            <p className="text-sm text-muted-foreground">Слепка страницы нет: агент старой версии или ошибка вне шага.</p>
          )}
        </div>
      </div>
      {issue.remoteSessions.length > 0 && (
        <section aria-label="Удалённые сессии" className="grid gap-1.5">
          <h4 className="text-xs text-muted-foreground">Удалённые сессии</h4>
          <ul data-testid="remote-sessions" className="grid gap-1 text-xs">
            {issue.remoteSessions.map((r) => (
              <li key={r.id}>
                <span className="tabular-nums">{dateTime(r.openedAt)}</span>, {r.openedBy ?? "—"}
                {r.endedAt ? <span className="text-muted-foreground"> — {r.endReason}</span> : <span className="text-ok"> — открыта</span>}
                {r.urls.length > 0 && <span className="block font-mono break-all text-muted-foreground">{r.urls.join(" → ")}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.data && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Журнал переходов ({run.data.transitions.length})</summary>
          <ol className="mt-2 grid gap-1 text-xs">
            {run.data.transitions.map((t, i) => (
              <li key={i}>
                <span className="text-muted-foreground tabular-nums">{dateTime(t.at)}</span>{" "}
                <span className="font-mono">
                  {t.from ?? "∅"} → <b>{t.to}</b>
                </span>
                {t.reason && <span className="text-muted-foreground"> — {t.reason}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** The operator fixed it by hand (remote access to the Mac) and writes down what was done. */
function ResolveDialog({ issue, onClose }: { issue: Issue; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const resolve = useMutation({
    mutationFn: () => api(`/runs/${issue.id}/resolve`, { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      notifyDone("Отмечено как доработанное");
      onClose();
    },
    onError: notifyError("Доработано"),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    resolve.mutate();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Проход {shortId(issue.id)} доработан?</DialogTitle>
            <DialogDescription>Опишите, что сделали вручную. Комментарий и слепок ошибки останутся для доработки движка; профиль вернётся в работу.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="resolve-note">Что сделано</Label>
            <Textarea id="resolve-note" value={note} onChange={(e) => setNote(e.target.value)} required rows={4} placeholder="Например: сайт показал капчу, прошёл её вручную и завершил заказ" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!note.trim() || resolve.isPending}>
              <Check aria-hidden />
              Доработано
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IssueRow({ issue, onResolve }: { issue: Issue; onResolve: (i: Issue) => void }) {
  const actions = useRunActions();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [remote, setRemote] = useState<string | null>(null);
  const connect = useMutation({
    mutationFn: () => api<{ sessionId: string }>(`/runs/${issue.id}/remote`, { method: "POST" }),
    onSuccess: ({ sessionId }) => setRemote(sessionId),
    onError: notifyError("Подключение к профилю"),
  });
  return (
    <li data-testid={`review-run-${issue.id}`} className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {issue.scenarioId}
            <Link to="/runs/$runId" params={{ runId: issue.id }} className="font-mono text-xs font-normal hover:underline">
              {shortId(issue.id)}
            </Link>
            <StatusBadge status={issue.status} />
            <span className="font-normal text-muted-foreground">
              {issue.profileName} на {issue.agentName}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-fail">{issue.errorCode ? `${issue.errorCode}: ${issue.errorMessage}` : "задание прервано, ожидает решения"}</p>
          {issue.resolvedAt && (
            <p data-testid="issue-resolution" className="mt-1 text-xs">
              <Check className="mr-1 inline size-3 text-ok" aria-hidden />
              {dateTime(issue.resolvedAt)}, {issue.resolvedBy}: {issue.resolvedNote}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          {!issue.resolvedAt && issue.status !== "RECOVERY_PENDING" && (
            <Button size="sm" variant="outline" disabled={connect.isPending} onClick={() => connect.mutate()}>
              <MonitorPlay aria-hidden />
              Подключиться
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Свернуть" : "Слепок ошибки"}
          </Button>
          {issue.status === "RECOVERY_PENDING" ? (
            <>
              <Button size="sm" onClick={() => actions.resume(issue.id)}>
                Продолжить
              </Button>
              <Button size="sm" variant="outline" onClick={() => actions.cancel(issue.id)}>
                Отменить
              </Button>
            </>
          ) : (
            !issue.resolvedAt && (
              <Button size="sm" onClick={() => onResolve(issue)}>
                <Check aria-hidden />
                Доработано
              </Button>
            )
          )}
        </div>
      </div>
      {open && <FailureDetails issue={issue} />}
      {remote && (
        <RemoteBrowser
          sessionId={remote}
          title={`Браузер профиля ${issue.profileName} на ${issue.agentName}`}
          description="Это настоящий браузер профиля на Mac: всё, что вы делаете, происходит на сайте. Закончив, закройте сессию и отметьте «Доработано»."
          onClose={(closedByOperator) => {
            setRemote(null);
            void queryClient.invalidateQueries({ queryKey: ["review"] });
            if (closedByOperator) onResolve(issue);
          }}
        />
      )}
    </li>
  );
}

/** «Недоработки»: runs that stopped on an error and need a person, with a precise picture of the failure. */
/** One failed LS Clicker run: the error first, then everything needed to fix it or the engine. */
function ClickerFailureRow({ failure: f, onResolve }: { failure: LsClickerFailure; onResolve: (f: LsClickerFailure) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const retry = useMutation({
    mutationFn: () => api(`/agents/${f.agentId}/ls-clicker/runs`, { method: "POST", body: JSON.stringify({ retry: true }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      notifyDone(`Повтор запущен на ${f.agentName}`);
    },
    onError: notifyError(`Повтор на ${f.agentName}`),
  });
  return (
    <li data-testid="review-lsc" className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-start gap-3 p-3">
        <button type="button" className="grid min-w-0 flex-1 gap-0.5 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="flex items-center gap-2 text-sm font-medium">
            <ChevronDown className={open ? "size-4" : "size-4 -rotate-90"} aria-hidden />
            {f.rowN ? `Строка ${f.rowN}` : "Строка"} <span className="font-normal text-muted-foreground">на {f.agentName}</span>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">{dateTime(f.finishedAt)}</span>
          </span>
          <span data-testid="review-lsc-error" className="text-xs break-words text-fail">
            {f.error}
          </span>
        </button>
        {!f.resolvedAt && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>
              <RotateCcw aria-hidden />
              Повторить
            </Button>
            <Button size="sm" onClick={() => onResolve(f)}>
              <Check aria-hidden />
              Доработано
            </Button>
          </div>
        )}
        {f.resolvedAt && (
          <p className="w-full text-xs text-muted-foreground">
            Доработано {dateTime(f.resolvedAt)}
            {f.resolvedBy && `, ${f.resolvedBy}`}: {f.resolvedNote}
          </p>
        )}
      </div>
      {open && (
        <div data-testid="review-lsc-details" className="grid gap-4 border-t p-3">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Этап">{f.stage?.node || "—"}</Field>
            <Field label="Адрес страницы">{f.stage?.url || "—"}</Field>
            <Field label="Профиль Linken Sphere">{f.lsProfile ? <code className="font-mono text-xs">{f.lsProfile}</code> : "не создан"}</Field>
            <Field label="Mac">{[f.agentName, f.agentModel].filter(Boolean).join(" · ")}</Field>
          </dl>
          {!!f.stage?.errors.length && (
            <div className="grid gap-1">
              <h4 className="text-xs text-muted-foreground">Ошибки движка на этапе</h4>
              <ul className="list-inside list-disc text-xs text-fail">
                {f.stage.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {f.screenshot && (
            <figure className="grid gap-1">
              <figcaption className="text-xs text-muted-foreground">Экран Mac в момент сбоя</figcaption>
              <a href={`/api/v1/ls-clicker/failures/${f.id}/screenshot`} target="_blank" rel="noreferrer">
                <img src={`/api/v1/ls-clicker/failures/${f.id}/screenshot`} alt={`Экран ${f.agentName} в момент сбоя`} className="max-h-96 rounded-md border" />
              </a>
            </figure>
          )}
          <div className="grid gap-1">
            <h4 className="text-xs text-muted-foreground">Журнал прогона: {f.log.length} строк</h4>
            <pre data-testid="review-lsc-log" className="max-h-96 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap">
              {f.log.join("\n")}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}

function ResolveClickerDialog({ failure: f, onClose }: { failure: LsClickerFailure; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const resolve = useMutation({
    mutationFn: () => api(`/ls-clicker/failures/${f.id}/resolve`, { method: "POST", body: JSON.stringify({ note }) }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      notifyDone("Отмечено как доработанное");
      onClose();
    },
    onError: notifyError("Доработано"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            resolve.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Сбой на {f.agentName} доработан?</DialogTitle>
            <DialogDescription>Опишите, что сделали. Комментарий, журнал и снимок останутся для доработки движка.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="resolve-lsc-note">Что сделано</Label>
            <Textarea id="resolve-lsc-note" value={note} onChange={(e) => setNote(e.target.value)} required rows={4} placeholder="Например: развернул окно Linken Sphere и повторил строку" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!note.trim() || resolve.isPending}>
              <Check aria-hidden />
              Доработано
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReviewPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [resolved, setResolved] = useState(false);
  const [resolving, setResolving] = useState<Issue | null>(null);
  const queue = useQuery({ queryKey: ["review", resolved], queryFn: () => api<ReviewQueue>(`/review${resolved ? "?resolved=true" : ""}`), refetchInterval: 2000 });
  const clicker = useQuery({ queryKey: ["review-lsc", resolved], queryFn: () => api<LsClickerFailure[]>(`/ls-clicker/failures${resolved ? "?resolved=true" : ""}`), refetchInterval: 5000 });
  const [resolvingClicker, setResolvingClicker] = useState<LsClickerFailure | null>(null);
  const release = useMutation({
    mutationFn: (id: string) => api(`/profiles/${id}/release-review`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries(),
    onError: notifyError("Вернуть профиль"),
  });
  const releaseProfile = async (p: ReviewQueue["profiles"][number]) => {
    if (await confirm({ title: `Профиль ${p.name} проверен?`, description: "После этого профиль снова получит задания. Убедитесь, что состояние сайта и браузера в порядке.", action: "Вернуть в работу" }))
      release.mutate(p.id);
  };
  const header = (
    <PageHeader
      title="Недоработки"
      description="Проходы, остановившиеся по ошибке. Почините на Mac через удалённый доступ и отметьте «Доработано» с комментарием; слепок ошибки остаётся для доработки движка."
      actions={
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Какие недоработки показать">
          {[false, true].map((v) => (
            <Button key={String(v)} size="sm" variant={resolved === v ? "secondary" : "ghost"} aria-pressed={resolved === v} onClick={() => setResolved(v)}>
              {v ? "Доработанные" : "Открытые"}
            </Button>
          ))}
        </div>
      }
    />
  );
  if (!queue.data) return header;
  const { runs, profiles } = queue.data;
  const failures = clicker.data ?? [];
  return (
    <>
      {header}
      {resolving && <ResolveDialog issue={resolving} onClose={() => setResolving(null)} />}
      {resolvingClicker && <ResolveClickerDialog failure={resolvingClicker} onClose={() => setResolvingClicker(null)} />}
      {failures.length > 0 && (
        <Section title="LS Clicker" count={failures.length}>
          <ul className="grid gap-2">
            {failures.map((f) => (
              <ClickerFailureRow key={f.id} failure={f} onResolve={setResolvingClicker} />
            ))}
          </ul>
        </Section>
      )}
      {!resolved && profiles.length > 0 && (
        <Section title="Профили на проверке" count={profiles.length}>
          <ul className="grid gap-2">
            {profiles.map((p) => (
              <li key={p.id} data-testid={`review-profile-${p.name}`} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {p.name} <span className="font-normal text-muted-foreground">на {p.agentName}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-fail">{p.lastError ?? "причина не указана"}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => releaseProfile(p)}>
                  Вернуть в работу
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {runs.length === 0 && failures.length > 0 ? null : runs.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={resolved ? "Доработанных пока нет" : "Недоработок нет"} description={resolved ? undefined : "Сюда попадает каждый проход, остановившийся по ошибке."} />
      ) : (
        <Section title="Проходы" count={runs.length}>
          <ul className="grid gap-2">
            {runs.map((r) => (
              <IssueRow key={r.id} issue={r} onResolve={setResolving} />
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

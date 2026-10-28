import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { HttpError, api } from "./api.ts";

interface Run {
  id: string;
  scenarioId: string;
  scenarioVersion: string;
  profileId: string;
  agentId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  queueReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
interface Step {
  sequence: number;
  stepId: string;
  mutating: boolean;
  status: "passed" | "failed" | "unverified";
  durationMs: number;
  error: string | null;
  screenshotArtifactId: string | null;
}
const FINAL = ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"];
const STATUSES = ["QUEUED", "ASSIGNED", "ACCEPTED", "RUNNING", "SUCCEEDED", "FAILED", "NEEDS_REVIEW", "CANCELLED"];
const MARK = { passed: "✓", failed: "✗", unverified: "?" } as const;

function NewRun({ onCreated }: { onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const scenarios = useQuery({ queryKey: ["scenarios"], queryFn: () => api<{ id: string; versions: { version: string }[] }[]>("/scenarios") });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<{ id: string; name: string; status: string; assignable: boolean }[]>("/profiles"), refetchInterval: 2000 });
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
      queryClient.invalidateQueries({ queryKey: ["runs"] });
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
    <form className="card new-run" onSubmit={submit}>
      <h2>Новый запуск</h2>
      <label>
        Сценарий
        <select value={scenario} onChange={(e) => setScenario(e.target.value)} required>
          <option value="">— выберите —</option>
          {scenarios.data?.flatMap((s) => s.versions.map((v) => <option key={`${s.id}@${v.version}`}>{`${s.id}@${v.version}`}</option>))}
        </select>
      </label>
      <label>
        Профиль
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} required>
          <option value="">— выберите —</option>
          {profiles.data?.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.assignable}>
              {p.assignable ? p.name : `${p.name} (${p.status})`}
            </option>
          ))}
        </select>
      </label>
      <label>
        Input (JSON)
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} />
      </label>
      <label>
        timeoutMs
        <input type="number" min={1000} step={1000} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} />
      </label>
      <button type="submit" disabled={create.isPending}>
        Запустить
      </button>
      {inputError && <p role="alert">{inputError}</p>}
      {create.error instanceof HttpError && <p role="alert">{create.error.code ?? `HTTP ${create.error.status}`}: {create.error.message}</p>}
    </form>
  );
}

const CANCELLABLE = ["QUEUED", "ASSIGNED", "ACCEPTED", "RUNNING", "RECOVERY_PENDING"];

export function useRunActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries();
  const cancel = useMutation({ mutationFn: (id: string) => api(`/runs/${id}/cancel`, { method: "POST" }), onSettled: refresh });
  const resume = useMutation({
    mutationFn: (id: string) => api(`/runs/${id}/resume`, { method: "POST", body: JSON.stringify({ mode: "safe-checkpoint", operatorConfirmed: true }) }),
    onSettled: refresh,
  });
  return {
    cancel: (id: string) => cancel.mutate(id),
    // Resuming is the operator's call: confirm that the run and the site were checked.
    resume: (id: string) => confirm("Продолжить задание с последней контрольной точки? Шаг, изменявший данные, будет проверен, а не повторён.") && resume.mutate(id),
  };
}

function RunDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const actions = useRunActions();
  const run = useQuery({
    queryKey: ["run", id],
    queryFn: () =>
      api<Run & { transitions: { from: string | null; to: string; reason: string | null; at: string }[]; checkpoints: { sequence: number; stepId: string }[] }>(`/runs/${id}`),
    refetchInterval: (q) => (q.state.data && FINAL.includes(q.state.data.status) ? false : 1000),
  });
  const steps = useQuery({
    queryKey: ["run-steps", id],
    queryFn: () => api<Step[]>(`/runs/${id}/steps`),
    refetchInterval: run.data && FINAL.includes(run.data.status) ? false : 1000,
  });
  if (!run.data) return null;
  const r = run.data;
  return (
    <section className="card run-detail" data-testid="run-detail">
      <header>
        <h2>
          {r.scenarioId}@{r.scenarioVersion} <span className={`badge run-${r.status}`} data-testid="run-status">{r.status}</span>
        </h2>
        <span className="actions">
          {CANCELLABLE.includes(r.status) && <button onClick={() => actions.cancel(r.id)}>Cancel</button>}
          {r.status === "RECOVERY_PENDING" && <button onClick={() => actions.resume(r.id)}>Resume</button>}
          <button onClick={onClose}>Закрыть</button>
        </span>
      </header>
      <p className="muted">
        run {r.id} · создан {new Date(r.createdAt).toLocaleTimeString()}
        {r.finishedAt && ` · завершён ${new Date(r.finishedAt).toLocaleTimeString()}`}
      </p>
      {r.errorCode && (
        <p className="error-text" data-testid="run-error">
          {r.errorCode}: {r.errorMessage}
        </p>
      )}
      <ol className="steps">
        {steps.data?.map((s) => (
          <li key={s.sequence} className={s.status} data-testid={`step-${s.stepId}`}>
            <div className="head">
              <b>
                {MARK[s.status]} {s.sequence}. {s.stepId}
              </b>
              {s.mutating && <span className="tag">mutating</span>}
              {r.checkpoints.some((c) => c.sequence === s.sequence) && <span className="tag checkpoint">checkpoint</span>}
              <span>{s.durationMs} мс</span>
            </div>
            {s.error && <pre className="error">{s.error}</pre>}
            {s.screenshotArtifactId && <img src={`/api/v1/runs/${r.id}/artifacts/${s.screenshotArtifactId}/content`} alt={s.stepId} />}
          </li>
        ))}
      </ol>
      <h3>Журнал переходов</h3>
      <ul className="transitions" data-testid="transitions">
        {r.transitions.map((t, i) => (
          <li key={i}>
            <span className="muted">{new Date(t.at).toLocaleTimeString()}</span> {t.from ?? "∅"} → <b>{t.to}</b>
            {t.reason && <span className="muted"> — {t.reason}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Runs() {
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const runs = useQuery({ queryKey: ["runs", status], queryFn: () => api<Run[]>(`/runs${status ? `?status=${status}` : ""}`), refetchInterval: 2000 });
  return (
    <>
      <NewRun onCreated={setSelected} />
      {selected && <RunDetail id={selected} onClose={() => setSelected(null)} />}
      <div className="filters">
        <label>
          Статус{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Фильтр статуса">
            <option value="">все</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      {runs.data?.length === 0 && <p className="empty">Заданий нет.</p>}
      {!!runs.data?.length && (
        <table className="agents runs">
          <thead>
            <tr>
              <th>Задание</th>
              <th>Сценарий</th>
              <th>Статус</th>
              <th>Создано</th>
              <th>Ожидание</th>
              <th>Длительность</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id} data-testid={`run-${r.id}`}>
                <td>
                  <button className="link" onClick={() => setSelected(r.id)}>
                    {r.id.slice(0, 8)}
                  </button>
                </td>
                <td>
                  {r.scenarioId}@{r.scenarioVersion}
                </td>
                <td>
                  <span className={`badge run-${r.status}`}>{r.status}</span>
                </td>
                <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                <td className="muted">
                  {r.status === "QUEUED"
                    ? `${Math.round((Date.now() - Date.parse(r.createdAt)) / 1000)} с${r.queueReason ? ` · ${r.queueReason}` : ""}`
                    : r.startedAt
                      ? `${((Date.parse(r.startedAt) - Date.parse(r.createdAt)) / 1000).toFixed(1)} с`
                      : "—"}
                </td>
                <td>{r.startedAt && r.finishedAt ? `${((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(1)} с` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

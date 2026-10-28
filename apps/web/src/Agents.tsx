import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api.ts";

interface Heartbeat {
  cpuPercent: number;
  memoryPercent: number;
  lsAvailable: boolean;
  activeSessions: number;
}

interface Agent {
  id: string;
  name: string;
  status: "ACTIVE" | "DRAINING" | "DISABLED" | "REVOKED";
  connection: "ONLINE" | "SUSPECT" | "OFFLINE";
  lastSeenAt: string | null;
  agentVersion: string | null;
  heartbeat: Heartbeat | null;
  maxSessions: number | null;
  reportedMaxSessions: number | null;
  sessionLimit: number | null;
  activeRuns: number;
}

const POLL_MS = 2000;

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const ago = (iso: string | null, now: number) => (iso ? `${Math.max(0, Math.round((now - Date.parse(iso)) / 1000))} с назад` : "никогда");

function Invite() {
  const invite = useMutation({ mutationFn: () => api<{ token: string; expiresAt: string }>("/agents/enrollments", { method: "POST" }) });
  return (
    <div className="invite">
      <button onClick={() => invite.mutate()}>Пригласить агента</button>
      {invite.data && (
        <div data-testid="invite">
          <p>Одноразовое приглашение, действует до {new Date(invite.data.expiresAt).toLocaleTimeString()}. На Mac выполните:</p>
          <pre>
            bap-agent enroll --server {location.origin} --token <span data-testid="invite-token">{invite.data.token}</span>
          </pre>
        </div>
      )}
    </div>
  );
}

function Sparkline({ values, label }: { values: number[]; label: string }) {
  const w = 240;
  const h = 48;
  const points = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - (v / 100) * h}`).join(" ");
  return (
    <figure className="spark">
      <svg width={w} height={h} role="img" aria-label={label}>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" />
      </svg>
      <figcaption>
        {label}: {values.at(-1)?.toFixed(1) ?? "—"}%
      </figcaption>
    </figure>
  );
}

function SessionLimit({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(agent.sessionLimit === null ? "" : String(agent.sessionLimit));
  const save = useMutation({
    mutationFn: () => api(`/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ sessionLimit: value === "" ? null : Number(value) }) }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <form
      className="limit"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label>
        Лимит сессий{" "}
        <input type="number" min={0} max={100} value={value} placeholder={`агент: ${agent.reportedMaxSessions ?? "—"}`} onChange={(e) => setValue(e.target.value)} aria-label="Лимит сессий" />
      </label>
      <button type="submit">Сохранить</button>
      <span className="muted"> пусто — как сообщает агент</span>
    </form>
  );
}

function AgentCard({ id, onClose }: { id: string; onClose: () => void }) {
  const card = useQuery({
    queryKey: ["agent", id],
    queryFn: () => api<Agent & { heartbeats: (Heartbeat & { at: string })[] }>(`/agents/${id}`),
    refetchInterval: POLL_MS,
  });
  if (!card.data) return null;
  return (
    <section className="card" data-testid="agent-card">
      <header>
        <h2>{card.data.name}</h2>
        <button onClick={onClose}>Закрыть</button>
      </header>
      <SessionLimit agent={card.data} />
      <Sparkline label="CPU" values={card.data.heartbeats.map((b) => b.cpuPercent)} />
      <Sparkline label="RAM" values={card.data.heartbeats.map((b) => b.memoryPercent)} />
      <p className="muted">Последние {card.data.heartbeats.length} heartbeat</p>
    </section>
  );
}

export function Agents() {
  const queryClient = useQueryClient();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/agents"), refetchInterval: POLL_MS });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "drain" | "disable" | "activate" | "revoke" | "rotate-key" }) => api(`/agents/${id}/${action}`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });
  const revoke = (agent: Agent) => {
    if (confirm(`Отозвать ключ агента ${agent.name}? Для возврата понадобится новое приглашение.`)) act.mutate({ id: agent.id, action: "revoke" });
  };

  return (
    <>
      <Invite />
      {agents.data?.length === 0 && <p className="empty">Агентов пока нет.</p>}
      {!!agents.data?.length && (
        <table className="agents">
          <thead>
            <tr>
              <th>Агент</th>
              <th>Статус</th>
              <th>Связь</th>
              <th>Last seen</th>
              <th>Версия</th>
              <th>LS</th>
              <th>CPU / RAM</th>
              <th>Слоты</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.data.map((a) => (
              <tr key={a.id} data-testid={`agent-${a.name}`}>
                <td>
                  <button className="link" onClick={() => setSelected(a.id)}>
                    {a.name}
                  </button>
                </td>
                <td>
                  <span className={`badge status-${a.status}`}>{a.status}</span>
                </td>
                <td>
                  <span className={`badge conn-${a.connection}`}>{a.connection}</span>
                </td>
                <td>{ago(a.lastSeenAt, now)}</td>
                <td>{a.agentVersion ?? "—"}</td>
                <td>{a.heartbeat ? (a.heartbeat.lsAvailable ? "✓" : "✗") : "—"}</td>
                <td>{a.heartbeat ? `${a.heartbeat.cpuPercent.toFixed(0)}% / ${a.heartbeat.memoryPercent.toFixed(0)}%` : "—"}</td>
                <td data-testid="slots">{a.maxSessions !== null ? `${a.activeRuns} / ${a.maxSessions}` : "—"}</td>
                <td className="actions">
                  {a.status === "DRAINING" || a.status === "DISABLED" ? (
                    <button onClick={() => act.mutate({ id: a.id, action: "activate" })}>Activate</button>
                  ) : (
                    <button disabled={a.status !== "ACTIVE"} onClick={() => act.mutate({ id: a.id, action: "drain" })}>
                      Drain
                    </button>
                  )}
                  <button disabled={a.status === "DISABLED" || a.status === "REVOKED"} onClick={() => act.mutate({ id: a.id, action: "disable" })}>
                    Disable
                  </button>
                  <button disabled={a.status === "REVOKED" || a.connection !== "ONLINE"} onClick={() => act.mutate({ id: a.id, action: "rotate-key" })}>
                    Rotate key
                  </button>
                  <button disabled={a.status === "REVOKED"} onClick={() => revoke(a)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && <AgentCard id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

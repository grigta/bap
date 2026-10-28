import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";
import { useRunActions } from "./Runs.tsx";

interface ReviewQueue {
  runs: { id: string; scenarioId: string; status: string; errorCode: string | null; errorMessage: string | null; finishedAt: string | null }[];
  profiles: { id: string; name: string; agentName: string; lastError: string | null; updatedAt: string }[];
}

/** Everything that waits for an operator decision, with the reason. */
export function Review() {
  const queryClient = useQueryClient();
  const actions = useRunActions();
  const queue = useQuery({ queryKey: ["review"], queryFn: () => api<ReviewQueue>("/review"), refetchInterval: 2000 });
  const release = useMutation({
    mutationFn: (id: string) => api(`/profiles/${id}/release-review`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries(),
  });
  if (!queue.data) return null;
  const { runs, profiles } = queue.data;
  return (
    <>
      <h2>Профили</h2>
      {profiles.length === 0 && <p className="empty">Нет профилей, ожидающих проверки.</p>}
      <ul className="review">
        {profiles.map((p) => (
          <li key={p.id} data-testid={`review-profile-${p.name}`}>
            <div>
              <b>{p.name}</b> <span className="muted">на {p.agentName}</span>
              <p className="error-text">{p.lastError ?? "причина не указана"}</p>
            </div>
            <button
              onClick={() => confirm(`Профиль ${p.name} проверен и его можно снова использовать?`) && release.mutate(p.id)}
            >
              Release
            </button>
          </li>
        ))}
      </ul>
      <h2>Задания</h2>
      {runs.length === 0 && <p className="empty">Нет заданий, ожидающих решения.</p>}
      <ul className="review">
        {runs.map((r) => (
          <li key={r.id} data-testid={`review-run-${r.id}`}>
            <div>
              <b>{r.scenarioId}</b> <code>{r.id.slice(0, 8)}</code> <span className={`badge run-${r.status}`}>{r.status}</span>
              <p className="error-text">{r.errorCode ? `${r.errorCode}: ${r.errorMessage}` : "задание прервано, ожидает решения"}</p>
            </div>
            {r.status === "RECOVERY_PENDING" && (
              <span className="actions">
                <button onClick={() => actions.resume(r.id)}>Resume</button>
                <button onClick={() => actions.cancel(r.id)}>Cancel</button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

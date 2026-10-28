import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HttpError, api } from "./api.ts";

interface Profile {
  id: string;
  name: string;
  externalProfileId: string;
  agentName: string;
  agentConnection: "ONLINE" | "SUSPECT" | "OFFLINE";
  status: "AVAILABLE" | "RESERVED" | "IN_USE" | "VERIFYING" | "NEEDS_REVIEW" | "DISABLED";
  assignable: boolean;
  activeRunId: string | null;
  lastError: string | null;
  lastVerifiedAt: string | null;
}

type Action = "verify" | "disable" | "enable" | "release-review";
const ACTIONS: { action: Action; label: string; from: Profile["status"][] }[] = [
  { action: "verify", label: "Verify", from: ["AVAILABLE", "NEEDS_REVIEW"] },
  { action: "disable", label: "Disable", from: ["AVAILABLE", "NEEDS_REVIEW"] },
  { action: "enable", label: "Enable", from: ["DISABLED"] },
  { action: "release-review", label: "Release review", from: ["NEEDS_REVIEW"] },
];
const POLL_MS = 2000;

function Import() {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState("");
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ id: string; name: string; connection: string }[]>("/agents"), refetchInterval: POLL_MS });
  const listed = useQuery({
    queryKey: ["provider-profiles", agentId],
    queryFn: () => api<{ id: string; name: string; importedAs: string | null }[]>(`/agents/${agentId}/provider-profiles`),
    enabled: agentId !== "",
  });
  const importOne = useMutation({
    mutationFn: (p: { id: string; name: string }) => api("/profiles/import", { method: "POST", body: JSON.stringify({ agentId, externalProfileId: p.id, name: p.name }) }),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <section className="card import">
      <label>
        Импорт с агента{" "}
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Агент">
          <option value="">— выберите —</option>
          {agents.data
            ?.filter((a) => a.connection === "ONLINE")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </label>
      {listed.isError && <p role="alert">Агент недоступен</p>}
      {listed.data && (
        <ul className="provider-profiles">
          {listed.data.map((p) => (
            <li key={p.id}>
              <span>{p.name}</span>
              <button disabled={p.importedAs !== null || importOne.isPending} onClick={() => importOne.mutate(p)}>
                {p.importedAs ? "Импортирован" : "Импортировать"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {importOne.error instanceof HttpError && <p role="alert">Импорт не удался (HTTP {importOne.error.status})</p>}
    </section>
  );
}

export function Profiles() {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/profiles"), refetchInterval: POLL_MS });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: Action }) => api(`/profiles/${id}/${action}`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["profiles"] }),
  });
  return (
    <>
      <Import />
      {profiles.data?.length === 0 && <p className="empty">Профилей пока нет.</p>}
      {!!profiles.data?.length && (
        <table className="agents profiles">
          <thead>
            <tr>
              <th>Профиль</th>
              <th>Агент</th>
              <th>Статус</th>
              <th>Задание</th>
              <th>Проверен</th>
              <th>Ошибка</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {profiles.data.map((p) => (
              <tr key={p.id} data-testid={`profile-${p.name}`}>
                <td>
                  {p.name}
                  <div className="muted">{p.externalProfileId}</div>
                </td>
                <td>
                  {p.agentName}
                  {p.agentConnection !== "ONLINE" && <div className="badge conn-OFFLINE">узел недоступен</div>}
                </td>
                <td>
                  <span className={`badge profile-${p.status}`}>{p.status}</span>
                </td>
                <td>{p.activeRunId ? <code title={p.activeRunId}>{p.activeRunId.slice(0, 8)}</code> : "—"}</td>
                <td>{p.lastVerifiedAt ? new Date(p.lastVerifiedAt).toLocaleString() : "—"}</td>
                <td className="error-text">{p.lastError ?? ""}</td>
                <td className="actions">
                  {ACTIONS.filter((a) => a.from.includes(p.status)).map((a) => (
                    <button key={a.action} disabled={p.agentConnection !== "ONLINE" && a.action !== "disable" && a.action !== "release-review"} onClick={() => act.mutate({ id: p.id, action: a.action })}>
                      {a.label}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

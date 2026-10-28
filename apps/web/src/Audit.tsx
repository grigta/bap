import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.ts";

interface AuditEvent {
  at: string;
  actor: string;
  action: string;
  outcome: "ok" | "denied";
  targetType: string | null;
  targetId: string | null;
  details: { status?: number; login?: string; name?: string };
}

/** Human names for audited routes; anything else is shown as the route itself. */
const ACTIONS: Record<string, string> = {
  "POST /api/v1/auth/login": "Вход",
  "POST /api/v1/auth/logout": "Выход",
  "POST /api/v1/auth/tokens": "Создан API-токен",
  "POST /api/v1/agents/enrollments": "Приглашение агента",
  "POST /api/v1/agents/enroll": "Регистрация агента",
  "POST /api/v1/agents/:id/drain": "Drain агента",
  "POST /api/v1/agents/:id/disable": "Disable агента",
  "POST /api/v1/agents/:id/activate": "Activate агента",
  "POST /api/v1/agents/:id/revoke": "Revoke агента",
  "POST /api/v1/agents/:id/rotate-key": "Ротация ключа (запрос)",
  "agent key rotated": "Ротация ключа (агент сменил ключ)",
  "POST /api/v1/agents/me/key": "Смена ключа агентом",
  "PATCH /api/v1/agents/:id": "Лимит сессий агента",
  "POST /api/v1/profiles/import": "Импорт профиля",
  "POST /api/v1/profiles/:id/verify": "Проверка профиля",
  "POST /api/v1/profiles/:id/enable": "Enable профиля",
  "POST /api/v1/profiles/:id/disable": "Disable профиля",
  "POST /api/v1/profiles/:id/release-review": "Release профиля",
  "POST /api/v1/scenarios/:id/versions": "Публикация сценария",
  "POST /api/v1/runs": "Запуск задания",
  "POST /api/v1/runs/:id/cancel": "Отмена задания",
  "POST /api/v1/runs/:id/resume": "Resume задания",
};

/** The operator's action journal (REQ-UI-006), newest first. */
export function Audit() {
  const [deniedOnly, setDeniedOnly] = useState(false);
  const events = useQuery({ queryKey: ["audit"], queryFn: () => api<AuditEvent[]>("/audit?limit=500"), refetchInterval: 2000 });
  if (!events.data) return null;
  const shown = deniedOnly ? events.data.filter((e) => e.outcome === "denied") : events.data;
  return (
    <>
      <label className="filters">
        <input type="checkbox" checked={deniedOnly} onChange={(e) => setDeniedOnly(e.target.checked)} /> Только отказы
      </label>
      {shown.length === 0 && <p className="empty">Записей нет.</p>}
      {shown.length > 0 && (
        <table className="agents audit">
          <thead>
            <tr>
              <th>Время</th>
              <th>Кто</th>
              <th>Действие</th>
              <th>Объект</th>
              <th>Итог</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.at}-${i}`} data-testid="audit-row">
                <td className="muted">{new Date(e.at).toLocaleString()}</td>
                <td>{e.actor}</td>
                <td title={e.action}>{ACTIONS[e.action] ?? e.action}</td>
                <td>
                  {e.targetType && <span className="muted">{e.targetType} </span>}
                  {e.targetId && <code>{e.targetId.slice(0, 8)}</code>}
                  {e.details.name && <span> {e.details.name}</span>}
                  {e.details.login && <span> {e.details.login}</span>}
                </td>
                <td>
                  <span className={`badge outcome-${e.outcome}`}>{e.outcome === "ok" ? "OK" : "DENIED"}</span>
                  {e.details.status !== undefined && <span className="muted"> {e.details.status}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

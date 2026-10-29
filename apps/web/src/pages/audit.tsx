import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ScrollText } from "lucide-react";
import { type Column, DataTable, columns } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { dateTime, shortId } from "@/lib/format";
import type { AuditEvent } from "@/lib/types";


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
  "DELETE /api/v1/agents/:id": "Удаление агента",
  "DELETE /api/v1/profiles/:id": "Удаление профиля",
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

/** The operator's action journal (REQ-UI-006), newest first; "denied only" lives in the URL. */
export function AuditPage({ denied }: { denied: boolean }) {
  const navigate = useNavigate();
  const events = useQuery({ queryKey: ["audit"], queryFn: () => api<AuditEvent[]>("/audit?limit=500"), refetchInterval: 2000 });
  const shown = (events.data ?? []).filter((e) => !denied || e.outcome === "denied");
  const c = columns<AuditEvent>();
  const cols: Column<AuditEvent>[] = [
    c.accessor("at", { header: "Время", cell: (i) => <span className="text-muted-foreground tabular-nums">{dateTime(i.getValue())}</span> }),
    c.accessor("actor", { header: "Кто", cell: (i) => <span className="font-mono text-xs">{i.getValue()}</span> }),
    c.accessor((e) => ACTIONS[e.action] ?? e.action, { id: "action", header: "Действие", cell: (i) => <span title={i.row.original.action}>{i.getValue()}</span> }),
    c.display({
      id: "target",
      header: "Объект",
      cell: (i) => {
        const e = i.row.original;
        return (
          <span className="text-sm">
            {e.targetType && <span className="text-muted-foreground">{e.targetType} </span>}
            {e.targetId && <code className="font-mono text-xs">{shortId(e.targetId)}</code>}
            {e.details.name && <span> {e.details.name}</span>}
            {e.details.login && <span> {e.details.login}</span>}
          </span>
        );
      },
    }),
    c.accessor("outcome", {
      header: "Итог",
      cell: (i) => (
        <span className="inline-flex items-center gap-2">
          <StatusBadge status={i.getValue() === "ok" ? "OK" : "DENIED"} />
          {i.row.original.details.status !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{i.row.original.details.status}</span>}
        </span>
      ),
    }),
  ];
  return (
    <>
      <PageHeader title="Все логи" description="Все изменяющие действия оператора и агентов, включая отказы. Тела запросов и секреты не сохраняются." />
      <div className="mb-3 flex items-center gap-2">
        <Checkbox id="denied-only" checked={denied} onCheckedChange={(v) => navigate({ to: "/audit", search: { denied: v ? true : undefined } })} />
        <Label htmlFor="denied-only">Только отказы</Label>
      </div>
      {events.data && shown.length === 0 && <EmptyState icon={ScrollText} title="Записей нет" description={denied ? "Отказов не было." : undefined} />}
      {shown.length > 0 && <DataTable id="audit" data={shown} columns={cols} rowTestId={() => "audit-row"} />}
    </>
  );
}

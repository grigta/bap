import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Tone = "ok" | "wait" | "fail" | "busy" | "idle";

/** Every status in the system, its tone and what it means to an operator. */
const STATUS: Record<string, [Tone, string]> = {
  // agents
  ACTIVE: ["ok", "Получает новые задания"],
  DRAINING: ["wait", "Доделывает текущие задания, новых не получает"],
  DISABLED: ["idle", "Отключён оператором"],
  REVOKED: ["fail", "Ключ отозван, подключиться не может"],
  ONLINE: ["ok", "На связи"],
  SUSPECT: ["wait", "Нет heartbeat — возможно, связь потеряна"],
  OFFLINE: ["fail", "Нет связи"],
  // profiles
  AVAILABLE: ["ok", "Свободен"],
  RESERVED: ["busy", "Зарезервирован под задание"],
  IN_USE: ["busy", "Задание выполняется"],
  VERIFYING: ["wait", "Ждём подтверждения, что браузер закрыт"],
  // runs
  QUEUED: ["idle", "В очереди"],
  ASSIGNED: ["busy", "Отправлено агенту"],
  ACCEPTED: ["busy", "Агент принял"],
  RUNNING: ["busy", "Выполняется"],
  CANCEL_REQUESTED: ["wait", "Отмена на границе шагов"],
  RECOVERY_PENDING: ["wait", "Прервано: решите — продолжить или отменить"],
  SUCCEEDED: ["ok", "Успешно"],
  FAILED: ["fail", "Ошибка"],
  NEEDS_REVIEW: ["wait", "Нужна проверка оператором"],
  CANCELLED: ["idle", "Отменено"],
  // audit
  OK: ["ok", "Разрешено"],
  DENIED: ["fail", "Отказано"],
};

const TONE: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  wait: "bg-wait-soft text-wait",
  fail: "bg-fail-soft text-fail",
  busy: "bg-busy-soft text-busy",
  idle: "bg-idle-soft text-idle",
};
const DOT: Record<Tone, string> = { ok: "bg-ok", wait: "bg-wait", fail: "bg-fail", busy: "bg-busy animate-pulse", idle: "bg-idle" };

export const toneOf = (status: string): Tone => STATUS[status]?.[0] ?? "idle";

export function StatusBadge({ status, className, ...props }: { status: string; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  const [tone, hint] = STATUS[status] ?? ["idle", status];
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("inline-flex h-5 items-center gap-1.5 rounded-sm px-1.5 font-mono text-[11px] font-medium whitespace-nowrap", TONE[tone], className)}
            {...props}
          />
        }
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
        <span data-slot="status-text">{status}</span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/layout/app-shell";
import { HttpError, api } from "@/lib/api";
import { time } from "@/lib/format";

type LsClickerStatus = {
  configured: true;
  run: { running: boolean; started_at: string | null; finished_at: string | null; ok: boolean | null; tail: string[] };
};

const when = (value: string | null | undefined) => (value ? time(value) : "—");

export function LsClickerPage() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["ls-clicker"], queryFn: () => api<LsClickerStatus>("/ls-clicker/status"), refetchInterval: 2_000 });
  const start = useMutation({
    mutationFn: () => api<{ accepted: true }>("/ls-clicker/runs", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ls-clicker"] }),
  });
  const run = status.data?.run;
  const message = status.error instanceof HttpError ? `${status.error.code ?? `HTTP ${status.error.status}`}: ${status.error.message}` : null;
  const result = run?.running ? "Выполняется" : run?.ok === true ? "Завершён успешно" : run?.ok === false ? "Завершён с ошибкой" : "Нет активного запуска";

  return (
    <>
      <PageHeader
        title="LS Clicker"
        description="Запускает обработку следующей строки через подключённую панель LS Clicker."
        actions={<Button onClick={() => start.mutate()} disabled={!run || run.running || start.isPending}><Play aria-hidden />{run?.running ? "Выполняется" : "Запустить строку"}</Button>}
      />
      {message ? (
        <p role="alert" className="rounded-lg border border-fail/30 bg-fail-soft p-4 text-sm text-fail">{message}</p>
      ) : (
        <section className="rounded-lg border bg-card" aria-label="Статус LS Clicker">
          <div className="grid gap-1 border-b p-4">
            <p className="text-sm font-medium">{result}</p>
            <p className="text-xs text-muted-foreground">Старт: {when(run?.started_at)} · Финиш: {when(run?.finished_at)}</p>
          </div>
          <pre className="max-h-[32rem] overflow-auto p-4 font-mono text-xs whitespace-pre-wrap">{run?.tail.join("\n") || "Журнал пока пуст."}</pre>
        </section>
      )}
      {start.error instanceof HttpError && <p role="alert" className="mt-3 text-sm text-fail">{start.error.code ?? `HTTP ${start.error.status}`}: {start.error.message}</p>}
    </>
  );
}

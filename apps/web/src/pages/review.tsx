import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ClipboardCheck } from "lucide-react";
import { useConfirm } from "@/components/confirm";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { shortId } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import type { ReviewQueue } from "@/lib/types";
import { useRunActions } from "./runs";

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

/** Everything that waits for an operator decision, with the reason. */
export function ReviewPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const actions = useRunActions();
  const queue = useQuery({ queryKey: ["review"], queryFn: () => api<ReviewQueue>("/review"), refetchInterval: 2000 });
  const release = useMutation({
    mutationFn: (id: string) => api(`/profiles/${id}/release-review`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries(),
    onError: notifyError("Release"),
  });
  if (!queue.data) return <PageHeader title="Проверка" />;
  const { runs, profiles } = queue.data;
  const releaseProfile = async (p: ReviewQueue["profiles"][number]) => {
    if (await confirm({ title: `Профиль ${p.name} проверен?`, description: "После этого профиль снова получит задания. Убедитесь, что состояние сайта и браузера в порядке.", action: "Вернуть в работу" }))
      release.mutate(p.id);
  };
  return (
    <>
      <PageHeader title="Проверка" description="Задания и профили, по которым нужно решение оператора: система сама их не повторяет." />
      {runs.length === 0 && profiles.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title="Ничего не ждёт проверки" description="Сюда попадают прерванные задания и профили после неоднозначных действий." />
      ) : (
        <>
          <Section title="Профили" count={profiles.length}>
            {profiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет профилей, ожидающих проверки.</p>
            ) : (
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
                      Release
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Задания" count={runs.length}>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет заданий, ожидающих решения.</p>
            ) : (
              <ul className="grid gap-2">
                {runs.map((r) => (
                  <li key={r.id} data-testid={`review-run-${r.id}`} className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {r.scenarioId}
                        <Link to="/runs/$runId" params={{ runId: r.id }} className="font-mono text-xs font-normal hover:underline">
                          {shortId(r.id)}
                        </Link>
                        <StatusBadge status={r.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-fail">{r.errorCode ? `${r.errorCode}: ${r.errorMessage}` : "задание прервано, ожидает решения"}</p>
                    </div>
                    {r.status === "RECOVERY_PENDING" && (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => actions.resume(r.id)}>
                          Resume
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => actions.cancel(r.id)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { UserRound, WifiOff } from "lucide-react";
import { useState } from "react";
import { type Column, DataTable, columns } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { dateTime, shortId } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import type { Agent, Profile } from "@/lib/types";

type Action = "verify" | "disable" | "enable" | "release-review";
const ACTIONS: { action: Action; label: string; from: Profile["status"][] }[] = [
  { action: "verify", label: "Verify", from: ["AVAILABLE", "NEEDS_REVIEW"] },
  { action: "disable", label: "Disable", from: ["AVAILABLE", "NEEDS_REVIEW"] },
  { action: "enable", label: "Enable", from: ["DISABLED"] },
  { action: "release-review", label: "Release review", from: ["NEEDS_REVIEW"] },
];
const POLL_MS = 2000;

/** Profiles that exist in Linken Sphere on a chosen Mac, imported one by one. */
function Import() {
  const queryClient = useQueryClient();
  const [agentId, setAgentId] = useState("");
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<Agent[]>("/agents"), refetchInterval: POLL_MS });
  const listed = useQuery({
    queryKey: ["provider-profiles", agentId],
    queryFn: () => api<{ id: string; name: string; importedAs: string | null }[]>(`/agents/${agentId}/provider-profiles`),
    enabled: agentId !== "",
  });
  const importOne = useMutation({
    mutationFn: (p: { id: string; name: string }) => api("/profiles/import", { method: "POST", body: JSON.stringify({ agentId, externalProfileId: p.id, name: p.name }) }),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: notifyError("Импорт профиля"),
  });
  return (
    <section className="mb-6 rounded-lg border bg-card p-4" aria-labelledby="import-title">
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1.5">
          <h2 id="import-title" className="text-sm font-medium">
            Импорт из Linken Sphere
          </h2>
          <Label htmlFor="import-agent" className="sr-only">
            Агент
          </Label>
          <NativeSelect id="import-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Агент" className="w-64">
            <NativeSelectOption value="">Выберите Mac на связи</NativeSelectOption>
            {agents.data
              ?.filter((a) => a.connection === "ONLINE")
              .map((a) => (
                <NativeSelectOption key={a.id} value={a.id}>
                  {a.name}
                </NativeSelectOption>
              ))}
          </NativeSelect>
        </div>
        <p className="max-w-prose pb-2 text-xs text-muted-foreground">Список сессий берётся с активного рабочего стола Linken Sphere выбранного Mac.</p>
      </div>
      {listed.isError && (
        <p role="alert" className="mt-3 text-sm text-fail">
          Агент недоступен
        </p>
      )}
      {listed.data && (
        <ul className="mt-4 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {listed.data.map((p) => (
            <li key={p.id} data-testid="provider-profile" className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
              <span className="truncate">{p.name}</span>
              <Button size="xs" variant={p.importedAs ? "ghost" : "outline"} disabled={p.importedAs !== null || importOne.isPending} onClick={() => importOne.mutate(p)}>
                {p.importedAs ? "Импортирован" : "Импортировать"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ProfilesPage() {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/profiles"), refetchInterval: POLL_MS });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: Action }) => api(`/profiles/${id}/${action}`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["profiles"] }),
    onError: notifyError("Действие с профилем"),
  });

  const c = columns<Profile>();
  const cols: Column<Profile>[] = [
    c.accessor("name", {
      header: "Профиль",
      cell: (i) => (
        <div className="min-w-0">
          <div className="font-medium">{i.getValue()}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">{i.row.original.externalProfileId}</div>
        </div>
      ),
    }),
    c.accessor("agentName", {
      header: "Агент",
      cell: (i) => (
        <div>
          {i.getValue()}
          {i.row.original.agentConnection !== "ONLINE" && (
            <div className="mt-0.5 flex items-center gap-1 text-xs text-fail">
              <WifiOff className="size-3" aria-hidden />
              узел недоступен
            </div>
          )}
        </div>
      ),
    }),
    c.accessor("status", { header: "Статус", cell: (i) => <StatusBadge status={i.getValue()} data-testid="profile-status" /> }),
    c.accessor("activeRunId", {
      header: "Задание",
      cell: (i) => {
        const id = i.getValue();
        return id ? (
          <Link to="/runs/$runId" params={{ runId: id }} className="font-mono text-xs hover:underline">
            {shortId(id)}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    }),
    c.accessor("lastVerifiedAt", {
      header: "Проверен",
      cell: (i) => (
        <span data-testid="profile-verified" className="tabular-nums text-muted-foreground">
          {i.getValue() ? dateTime(i.getValue()!) : "—"}
        </span>
      ),
    }),
    c.accessor("lastError", { header: "Последняя ошибка", enableSorting: false, cell: (i) => <span className="line-clamp-2 block max-w-56 text-xs whitespace-normal text-fail">{i.getValue() ?? ""}</span> }),
    c.display({
      id: "actions",
      header: () => <span className="sr-only">Действия</span>,
      cell: (i) => {
        const p = i.row.original;
        return (
          <div className="flex justify-end gap-1">
            {ACTIONS.filter((a) => a.from.includes(p.status)).map((a) => (
              <Button
                key={a.action}
                size="xs"
                variant="outline"
                disabled={p.agentConnection !== "ONLINE" && a.action !== "disable" && a.action !== "release-review"}
                onClick={() => act.mutate({ id: p.id, action: a.action })}
              >
                {a.label}
              </Button>
            ))}
          </div>
        );
      },
    }),
  ];

  return (
    <>
      <PageHeader title="Профили" description="Сессии Linken Sphere, на которых выполняются задания. Один профиль — одно задание одновременно." />
      <Import />
      {profiles.data?.length === 0 && <EmptyState icon={UserRound} title="Профилей пока нет" description="Импортируйте сессии Linken Sphere с Mac, который на связи." />}
      {!!profiles.data?.length && <DataTable id="profiles" data={profiles.data} columns={cols} rowTestId={(p) => `profile-${p.name}`} />}
    </>
  );
}

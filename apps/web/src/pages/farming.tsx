import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Flame, Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { type Column, DataTable, columns } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { notifyError } from "@/lib/notify";
import type { FarmingSettings, Profile } from "@/lib/types";

const POLL_MS = 2000;

/** "2/3" while a profile still warms up, "допущен" once it may run recipes. */
export const warmth = (p: Profile, s: FarmingSettings | undefined) => (s === undefined ? "" : p.warmups >= s.requiredWarmups ? "допущен" : `${p.warmups}/${s.requiredWarmups}`);

function Settings({ current }: { current: FarmingSettings }) {
  const queryClient = useQueryClient();
  const [queries, setQueries] = useState(current.queries.join("\n"));
  const [required, setRequired] = useState(String(current.requiredWarmups));
  const [sites, setSites] = useState(String(current.sites));
  const [dwell, setDwell] = useState(String(current.dwellSeconds));
  const [searchUrl, setSearchUrl] = useState(current.searchUrl);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [queries, required, sites, dwell, searchUrl]);
  const save = useMutation({
    mutationFn: (body: FarmingSettings) => api<FarmingSettings>("/farming/settings", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (s) => {
      queryClient.setQueryData(["farming-settings"], s);
      setSaved(true);
    },
    onError: notifyError("Настройки прогрева"),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      queries: queries.split("\n").map((q) => q.trim()).filter(Boolean),
      requiredWarmups: Number(required),
      sites: Number(sites),
      dwellSeconds: Number(dwell),
      searchUrl,
    });
  };
  return (
    <form onSubmit={submit} className="mb-6 grid gap-4 rounded-lg border bg-card p-4 lg:grid-cols-[1fr_auto]" aria-labelledby="farming-settings">
      <h2 id="farming-settings" className="sr-only">
        Настройки прогрева
      </h2>
      <div className="grid gap-1.5">
        <Label htmlFor="farm-queries">Поисковые запросы</Label>
        <Textarea id="farm-queries" value={queries} onChange={(e) => setQueries(e.target.value)} required rows={6} className="font-mono text-xs" />
        <p className="text-xs text-muted-foreground">По одному в строке. Каждая сессия берёт случайный.</p>
      </div>
      <div className="grid content-start gap-3 sm:grid-cols-2 lg:w-96">
        <div className="grid gap-1.5">
          <Label htmlFor="farm-required">Прогревов до допуска</Label>
          <Input id="farm-required" type="number" min={0} max={10} value={required} onChange={(e) => setRequired(e.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="farm-sites">Сайтов за сессию</Label>
          <Input id="farm-sites" type="number" min={1} max={10} value={sites} onChange={(e) => setSites(e.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="farm-dwell">Секунд на сайте</Label>
          <Input id="farm-dwell" type="number" min={1} max={600} value={dwell} onChange={(e) => setDwell(e.target.value)} required />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="farm-search">Поисковик</Label>
          <Input id="farm-search" type="url" value={searchUrl} onChange={(e) => setSearchUrl(e.target.value)} required />
        </div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={save.isPending}>
            <Save aria-hidden />
            Сохранить
          </Button>
          {saved && (
            <span role="status" className="text-sm text-muted-foreground">
              Сохранено
            </span>
          )}
        </div>
      </div>
    </form>
  );
}

export function FarmingPage() {
  const navigate = useNavigate();
  const settings = useQuery({ queryKey: ["farming-settings"], queryFn: () => api<FarmingSettings>("/farming/settings") });
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/profiles"), refetchInterval: POLL_MS });
  const farm = useMutation({
    mutationFn: (id: string) => api<{ runId: string }>(`/profiles/${id}/farm`, { method: "POST" }),
    onSuccess: ({ runId }) => navigate({ to: "/runs/$runId", params: { runId }, search: {} }),
    onError: notifyError("Прогрев профиля"),
  });

  const c = columns<Profile>();
  const cols: Column<Profile>[] = [
    c.accessor("name", { header: "Профиль", cell: (i) => <span className="font-medium">{i.getValue()}</span> }),
    c.accessor("agentName", { header: "Агент" }),
    c.accessor("status", { header: "Статус", cell: (i) => <StatusBadge status={i.getValue()} /> }),
    c.accessor("warmups", {
      header: "Прогрев",
      cell: (i) => (
        <span data-testid="profile-warmth" className="tabular-nums">
          {warmth(i.row.original, settings.data)}
        </span>
      ),
    }),
    c.accessor("warmupFailures", { header: "Неудач подряд", cell: (i) => <span className={i.getValue() > 0 ? "text-fail tabular-nums" : "text-muted-foreground tabular-nums"}>{i.getValue()}</span> }),
    c.display({
      id: "actions",
      header: () => <span className="sr-only">Действия</span>,
      cell: (i) => {
        const p = i.row.original;
        return (
          <div className="flex justify-end">
            <Button size="xs" variant="outline" disabled={p.status === "NEEDS_REVIEW" || p.status === "DISABLED" || farm.isPending} onClick={() => farm.mutate(p.id)}>
              <Flame aria-hidden />
              Прогреть
            </Button>
          </div>
        );
      },
    }),
  ];

  return (
    <>
      <PageHeader title="Прогрев" description="Перед рецептами профиль проходит несколько сессий обычного поведения: поиск, сайты из выдачи, чтение страницы прокруткой. Если рецепт запущен на непрогретом профиле, он ждёт, а прогрев ставится сам." />
      {settings.data && <Settings current={settings.data} />}
      {profiles.data?.length === 0 && <EmptyState icon={Flame} title="Профилей пока нет" description="Импортируйте сессии Linken Sphere на странице «Профили»." />}
      {!!profiles.data?.length && <DataTable id="farming" data={profiles.data} columns={cols} rowTestId={(p) => `warm-${p.name}`} />}
    </>
  );
}

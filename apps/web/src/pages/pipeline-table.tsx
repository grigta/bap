import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download, FileUp, Table2, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { notifyDone, notifyError } from "@/lib/notify";
import type { Pipeline } from "@/lib/types";

/** Rows drawn at once: a big table stays responsive; the search narrows it down. */
const SHOWN = 500;

/**
 * The operator's own table (REQ-UI-012): any CSV, shown as it came, with the state of the matching
 * profile next to each row. Its contents stay between the operator and the server.
 */
export function PipelineTable() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const file = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const table = useQuery({ queryKey: ["pipeline"], queryFn: () => api<Pipeline>("/pipeline"), refetchInterval: 5000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["pipeline"] });

  const upload = useMutation({
    mutationFn: async (f: File) =>
      api<{ rows: number; columns: number }>(`/pipeline/import?name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.text(), headers: { "content-type": "text/csv" } }),
    onSuccess: (r) => {
      void refresh();
      notifyDone(`Загружено строк: ${r.rows}`, `Колонок: ${r.columns}. Выберите колонку с профилем.`);
    },
    onError: notifyError("Импорт CSV"),
  });
  const setColumn = useMutation({
    mutationFn: (column: number | null) => api(`/pipeline/profile-column`, { method: "PUT", body: JSON.stringify({ column }) }),
    onSuccess: () => void refresh(),
    onError: notifyError("Колонка с профилем"),
  });
  const clear = useMutation({ mutationFn: () => api(`/pipeline`, { method: "DELETE" }), onSuccess: () => void refresh(), onError: notifyError("Очистить таблицу") });

  const imp = table.data?.import ?? null;
  const rows = useMemo(() => {
    const all = table.data?.rows ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q))) : all;
  }, [table.data, search]);
  const matched = table.data?.rows.filter((r) => r.ours).length ?? 0;

  const pick = (
    <>
      <input
        ref={file}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        aria-label="Файл CSV"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload.mutate(f);
          e.target.value = "";
        }}
      />
      <Button onClick={() => file.current?.click()} disabled={upload.isPending}>
        <FileUp aria-hidden />
        Импорт CSV
      </Button>
    </>
  );

  if (table.data && !imp)
    return (
      <EmptyState icon={Table2} title="Таблица не загружена" description="Загрузите свою таблицу в CSV: строки покажутся здесь вместе с состоянием профилей, выгрузка добавит наши колонки." action={pick} />
    );
  if (!imp) return null;
  return (
    <section aria-label="Таблица" className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1">
          <span data-testid="pipeline-file" className="text-sm font-medium">
            {imp.fileName}
          </span>
          <span className="text-xs text-muted-foreground">
            строк {imp.rowCount}, с профилем {matched} · загружено {dateTime(imp.createdAt)}
            {imp.createdBy && `, ${imp.createdBy}`}
          </span>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="pipeline-profile-column" className="text-xs text-muted-foreground">
            Колонка с профилем
          </Label>
          <NativeSelect
            id="pipeline-profile-column"
            size="sm"
            className="w-56"
            value={imp.profileColumn ?? ""}
            onChange={(e) => setColumn.mutate(e.target.value === "" ? null : Number(e.target.value))}
          >
            <NativeSelectOption value="">не выбрана</NativeSelectOption>
            {imp.columns.map((c, i) => (
              <NativeSelectOption key={i} value={i}>
                {c || `колонка ${i + 1}`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Input aria-label="Поиск по таблице" placeholder="Поиск по таблице" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-56" />
        <div className="ml-auto flex gap-2">
          {pick}
          <Button variant="outline" render={<a href="/api/v1/pipeline/export" download />}>
            <Download aria-hidden />
            Выгрузить CSV
          </Button>
          <Button
            variant="ghost"
            aria-label="Очистить таблицу"
            onClick={async () => {
              if (await confirm({ title: "Удалить загруженную таблицу?", description: "Строки удалятся с сервера. Профили и проходы не изменятся.", action: "Удалить", destructive: true })) clear.mutate();
            }}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-lg border bg-card">
        <table data-testid="pipeline-table" className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-muted text-left text-xs text-muted-foreground">
            <tr>
              {imp.columns.map((c, i) => (
                <th key={i} scope="col" className={i === imp.profileColumn ? "px-3 py-2 font-medium text-foreground" : "px-3 py-2 font-medium"}>
                  {c || `колонка ${i + 1}`}
                </th>
              ))}
              {["Статус профиля", "Mac", "Последний проход", "Ошибка"].map((c) => (
                <th key={c} scope="col" className="border-l px-3 py-2 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, SHOWN).map((r, n) => (
              <tr key={n} data-testid="pipeline-row" className="border-t align-top">
                {r.cells.map((c, i) => (
                  <td key={i} className="max-w-64 px-3 py-2 break-words">
                    {c}
                  </td>
                ))}
                <td className="border-l px-3 py-2">{r.ours ? <StatusBadge status={r.ours.profileStatus} data-testid="pipeline-profile-status" /> : <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-2">
                  {r.ours ? (
                    <>
                      {r.ours.agentName}
                      {r.ours.agentModel && <span className="block text-xs text-muted-foreground">{r.ours.agentModel}</span>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {r.ours?.lastRun ? (
                    <Link to="/runs/$runId" params={{ runId: r.ours.lastRun.id }} search={{}} className="grid justify-items-start gap-1 hover:underline">
                      <span>{r.ours.lastRun.scenarioId}</span>
                      <StatusBadge status={r.ours.lastRun.status} />
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="max-w-64 px-3 py-2 text-xs text-fail">{r.ours?.lastRun?.errorCode ? `${r.ours.lastRun.errorCode}: ${r.ours.lastRun.errorMessage ?? ""}` : (r.ours?.profileLastError ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > SHOWN && <p className="p-3 text-xs text-muted-foreground">Показаны первые {SHOWN} из {rows.length}: уточните поиск. В выгрузке — все строки.</p>}
        {rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">Ничего не найдено.</p>}
      </div>
    </section>
  );
}

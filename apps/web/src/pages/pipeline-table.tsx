import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Clock, Download, FileUp, Pencil, Plus, Table2, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dateTime } from "@/lib/format";
import { notifyDone, notifyError } from "@/lib/notify";
import type { Pipeline } from "@/lib/types";

/** A proxy as LS Clicker takes it: socks5 ip:port, optionally @login:pass. */
const PROXY_FORMAT = /^[^\s:@]+:\d{1,5}(@[^\s:@]+:\S+)?$/;
/** The password is not on screen until the cell is opened. */
const maskProxy = (p: string) => p.replace(/^([^@]+@[^:]+:).+$/, "$1•••");

/**
 * A cell the operator edits in place: click, type, Enter or leaving saves, Esc cancels. `locked` explains
 * why it cannot change (e.g. the row is already on a Mac).
 */
function EditableCell({ value, label, locked, shown, placeholder, check, onSave, testId }: { value: string; label: string; locked?: string; shown?: string; placeholder?: string; check?: (v: string) => string | null; onSave: (v: string) => void; testId?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const problem = draft !== null && check ? check(draft) : null;
  const save = () => {
    if (draft === null || problem) return;
    if (draft !== value) onSave(draft);
    setDraft(null);
  };
  if (draft === null)
    return (
      <button
        type="button"
        data-testid={testId}
        disabled={!!locked}
        title={locked ?? "Изменить"}
        aria-label={`${label}: ${shown ?? value}`}
        onClick={() => setDraft(value)}
        className="group/cell flex w-full items-start gap-1 rounded-sm text-left break-words hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="min-w-0 flex-1">
          {shown ?? value}
          {!value && <span className="text-muted-foreground">{placeholder ?? "—"}</span>}
        </span>
        {!locked && <Pencil className="mt-0.5 size-3 shrink-0 text-muted-foreground opacity-0 group-hover/cell:opacity-100" aria-hidden />}
      </button>
    );
  return (
    <div className="grid gap-1">
      <Input
        autoFocus
        aria-label={label}
        aria-invalid={!!problem}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setDraft(null);
        }}
        className="h-7 min-w-40 text-xs"
      />
      {problem && <span className="text-[11px] text-fail">{problem}</span>}
    </div>
  );
}

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
  const box = useRef<HTMLDivElement>(null);
  const topBar = useRef<HTMLDivElement>(null);
  const tableEl = useRef<HTMLTableElement>(null);
  const [wide, setWide] = useState(0);
  // The top scrollbar is as wide as the table and moves with it.
  useEffect(() => {
    const table = tableEl.current;
    if (!table) return;
    const measure = new ResizeObserver(() => setWide(table.scrollWidth));
    measure.observe(table);
    return () => measure.disconnect();
  });
  const sync = (from: React.RefObject<HTMLDivElement | null>, to: React.RefObject<HTMLDivElement | null>) => {
    if (from.current && to.current && to.current.scrollLeft !== from.current.scrollLeft) to.current.scrollLeft = from.current.scrollLeft;
  };
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
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
  const edit = useMutation({
    mutationFn: ({ n, body }: { n: number; body: { cells?: string[]; proxy?: string } }) => api(`/pipeline/rows/${n}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => void refresh(),
    onError: notifyError("Правка строки"),
  });
  const clear = useMutation({ mutationFn: () => api(`/pipeline`, { method: "DELETE" }), onSuccess: () => void refresh(), onError: notifyError("Очистить таблицу") });
  const remove = useMutation({
    mutationFn: (n: number) => api(`/pipeline/rows/${n}`, { method: "DELETE" }),
    onSuccess: (_, n) => {
      notifyDone(`Строка ${n} удалена`);
      setOpen(null);
      void refresh();
    },
    onError: notifyError("Удалить строку"),
  });

  const imp = table.data?.import ?? null;
  const rows = useMemo(() => {
    const all = table.data?.rows ?? [];
    const q = search.trim().toLowerCase();
    return q ? all.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q))) : all;
  }, [table.data, search]);
  const matched = table.data?.rows.filter((r) => r.ours).length ?? 0;
  const shown = table.data?.rows.find((r) => r.n === open);

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
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Строка
          </Button>
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
      <p className="text-xs text-muted-foreground">✓ — значение есть, ✗ — пусто. Нажмите на строку, чтобы открыть её данные: там их можно изменить и задать прокси.</p>
      {/* A scrollbar above the table too: a wide table moves sideways without scrolling down to its end first. */}
      <div ref={topBar} aria-hidden data-testid="pipeline-scroll-top" onScroll={() => sync(topBar, box)} className="overflow-x-auto overflow-y-hidden">
        <div style={{ width: wide, height: 1 }} />
      </div>
      <div ref={box} data-testid="pipeline-scroll" onScroll={() => sync(box, topBar)} className="max-h-[calc(100dvh-14rem)] overflow-auto rounded-lg border bg-card">
        <table ref={tableEl} data-testid="pipeline-table" className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
            <tr>
              <th scope="col" className="px-2 py-1 text-left font-medium">
                #
              </th>
              {[...imp.columns.map((c, i) => c || `колонка ${i + 1}`), "Прокси", "LS Clicker", "Статус профиля"].map((c, i) => (
                <th key={i} scope="col" title={c} className={cn("h-28 px-1 py-1 align-bottom font-medium", i === imp.columns.length && "border-l")}>
                  {/* Turned on its side: a dozen columns fit where a few names would. */}
                  <span className="mx-auto block max-h-24 truncate [writing-mode:vertical-rl] rotate-180">{c}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, SHOWN).map((r) => (
              <tr key={r.n} data-testid="pipeline-row" onClick={() => setOpen(r.n)} className={cn("cursor-pointer border-t hover:bg-accent/60", open === r.n && "bg-accent")}>
                <td className="px-2 py-1 text-muted-foreground tabular-nums">
                  <button type="button" className="hover:underline" aria-label={`Открыть строку ${r.n}`} onClick={() => setOpen(r.n)}>
                    {r.n}
                  </button>
                </td>
                {r.cells.map((c, i) => (
                  <td key={i} className="px-1 py-1 text-center">
                    <Filled filled={c.trim() !== ""} label={imp.columns[i] || `колонка ${i + 1}`} />
                  </td>
                ))}
                <td className="border-l px-1 py-1 text-center" data-testid="pipeline-proxy">
                  <Filled filled={!!r.proxy} label="Прокси" />
                </td>
                <td className="px-1 py-1 text-center" data-testid="pipeline-lsc" title={r.lsc ? `${r.lsc.agentName}: ${r.lsc.result ? "обработана" : "в очереди"}` : "не отправлена"}>
                  {r.lsc ? r.lsc.result ? <Check className="mx-auto size-3.5 text-ok" aria-label="обработана" /> : <Clock className="mx-auto size-3.5 text-wait" aria-label="в очереди" /> : <span className="text-muted-foreground">·</span>}
                </td>
                <td className="px-1 py-1 text-center">{r.ours ? <StatusBadge status={r.ours.profileStatus} data-testid="pipeline-profile-status" /> : <span className="text-muted-foreground">·</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > SHOWN && <p className="p-3 text-xs text-muted-foreground">Показаны первые {SHOWN} из {rows.length}: уточните поиск. В выгрузке — все строки.</p>}
        {rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">Ничего не найдено.</p>}
      </div>
      {shown && (
        <RowSheet row={shown} columns={imp.columns} onClose={() => setOpen(null)} onSave={(body) => edit.mutate({ n: shown.n, body })}
          onDelete={async () => {
            if (await confirm({ title: `Удалить строку ${shown.n}?`, description: "Строка удалится из таблицы. Номера остальных строк не изменятся.", action: "Удалить", destructive: true })) remove.mutate(shown.n);
          }}
        />
      )}
      {adding && <AddRows columns={imp.columns} onClose={() => setAdding(false)} onAdded={() => void refresh()} />}
    </section>
  );
}

/** ✓ when the field has a value, ✗ when it is empty: the overview shows completeness, not the data. */
function Filled({ filled, label }: { filled: boolean; label: string }) {
  return filled ? <Check className="mx-auto size-3.5 text-ok" aria-label={`${label}: есть`} /> : <X className="mx-auto size-3.5 text-fail/70" aria-label={`${label}: пусто`} />;
}

/** One row in full: every field editable, the proxy, and what BAP and LS Clicker know about it. */
function RowSheet({ row: r, columns, onClose, onSave, onDelete }: { row: Pipeline["rows"][number]; columns: string[]; onClose: () => void; onSave: (body: { cells?: string[]; proxy?: string }) => void; onDelete: () => void }) {
  const locked = r.lsc ? "Строка уже на Mac: в input.csv она не меняется" : undefined;
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-xl" data-testid="pipeline-row-sheet">
        <SheetHeader className="border-b">
          <SheetTitle>Строка {r.n}</SheetTitle>
          <SheetDescription>{locked ?? "Нажмите на значение, чтобы изменить его (Enter — сохранить, Esc — отменить)."}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 overflow-y-auto p-4 text-sm">
          <section aria-label="Прокси" className="grid gap-1">
            <h3 className="text-xs text-muted-foreground">Прокси — подключается к профилю Linken Sphere этой строки</h3>
            <div className="font-mono text-xs">
              <EditableCell
                testId="pipeline-proxy-edit"
                value={r.proxy ?? ""}
                shown={r.proxy ? maskProxy(r.proxy) : undefined}
                label={`Прокси, строка ${r.n}`}
                placeholder="+ прокси"
                locked={r.lsc?.result ? "Строка обработана: прокси больше не используется" : undefined}
                check={(v) => (v.trim() === "" || PROXY_FORMAT.test(v.trim()) ? null : "ip:port или ip:port@login:pass")}
                onSave={(v) => onSave({ proxy: v.trim() })}
              />
            </div>
          </section>
          <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1.5">
            {r.cells.map((c, i) => (
              <div key={i} className="contents">
                <dt className="truncate pt-0.5 text-xs text-muted-foreground" title={columns[i]}>
                  {columns[i] || `колонка ${i + 1}`}
                </dt>
                <dd className="min-w-0">
                  <EditableCell value={c} label={`${columns[i] || `колонка ${i + 1}`}, строка ${r.n}`} locked={locked} onSave={(v) => onSave({ cells: r.cells.map((x, j) => (j === i ? v : x)) })} />
                </dd>
              </div>
            ))}
          </dl>
          <section aria-label="Состояние" className="grid gap-1.5 border-t pt-3 text-xs">
            <div>
              Профиль: {r.ours ? <StatusBadge status={r.ours.profileStatus} /> : <span className="text-muted-foreground">не связан</span>}
              {r.ours && <span className="text-muted-foreground"> · {r.ours.agentName}</span>}
            </div>
            {r.ours?.lastRun && (
              <div>
                Последний проход:{" "}
                <Link to="/runs/$runId" params={{ runId: r.ours.lastRun.id }} search={{}} className="hover:underline">
                  {r.ours.lastRun.scenarioId}
                </Link>{" "}
                <StatusBadge status={r.ours.lastRun.status} />
                {r.ours.lastRun.errorCode && <span className="block text-fail">{`${r.ours.lastRun.errorCode}: ${r.ours.lastRun.errorMessage ?? ""}`}</span>}
              </div>
            )}
            <div>
              LS Clicker: {r.lsc ? `${r.lsc.agentName} · ${r.lsc.result ? "обработана" : "в очереди"}` : <span className="text-muted-foreground">не отправлена</span>}
            </div>
            {r.lsc?.result && (
              <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-1 rounded-md bg-muted/50 p-2">
                {r.lsc.result.header.map((h, i) => (
                  <div key={i} className="contents">
                    <dt className="truncate text-muted-foreground">{h}</dt>
                    <dd className="break-words">{r.lsc!.result!.cells[i] ?? ""}</dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
          {/* A row on a Mac keeps its place in input.csv there, so only an unsent row can go. */}
          {!r.lsc && (
            <Button variant="outline" className="justify-self-start text-fail" onClick={onDelete}>
              <Trash2 aria-hidden />
              Удалить строку
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** «+ строка»: lines of comma-separated values in the table's column order, one row per line. */
function AddRows({ columns, onClose, onAdded }: { columns: string[]; onClose: () => void; onAdded: () => void }) {
  const [text, setText] = useState("");
  const add = useMutation({
    mutationFn: () => api<{ added: number }>("/pipeline/rows", { method: "POST", body: JSON.stringify({ text }) }),
    onSuccess: (r) => {
      notifyDone(`Добавлено строк: ${r.added}`);
      onAdded();
      onClose();
    },
    onError: notifyError("Добавить строки"),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form
          className="grid min-w-0 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Добавить строки</DialogTitle>
            <DialogDescription>Одна строка — одна запись. Значения через запятую в порядке колонок; значение с запятой — в кавычках. Недостающие останутся пустыми.</DialogDescription>
          </DialogHeader>
          <p className="max-h-24 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] break-all text-muted-foreground">{columns.map((c, i) => c || `колонка ${i + 1}`).join(",")}</p>
          <Label htmlFor="add-rows" className="sr-only">
            Строки
          </Label>
          <Textarea id="add-rows" value={text} onChange={(e) => setText(e.target.value)} rows={6} className="max-h-72 min-w-0 font-mono text-xs [field-sizing:fixed]" placeholder="значение1,значение2,…" required />
          <DialogFooter>
            <Button type="submit" disabled={!text.trim() || add.isPending}>
              <Plus aria-hidden />
              Добавить
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

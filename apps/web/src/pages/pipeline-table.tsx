import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Download, FileUp, Maximize2, Minimize2, Pencil, Play, Plus, Settings2, Table2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { PageHeader } from "@/layout/app-shell";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { dateTime } from "@/lib/format";
import { notifyDone, notifyError } from "@/lib/notify";
import type { Pipeline } from "@/lib/types";
import { LsClickerPanel } from "./ls-clicker";

/** A proxy as LS Clicker takes it: socks5 ip:port, optionally @login:pass. */
const PROXY_FORMAT = /^[^\s:@]+:\d{1,5}(@[^\s:@]+:\S+)?$/;
/** A row whose status column says good or bad has been done: LS Clicker skips it (as on the server). */
const DONE_STATUSES = ["good", "bad", "гуд", "бед"];
const statusColumn = (columns: string[]) => columns.findIndex((c) => ["status", "статус"].includes(c.trim().toLowerCase()));
/** «wait info»: a row runs only once its number and proxy are filled in (as on the server). */
const numberColumn = (columns: string[]) => columns.findIndex((c) => c.trim().toLowerCase() === "number");
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

const PAGE_SIZES = [25, 50, 100, 250] as const;
/** Columns shown when the table is collapsed, until the operator picks their own. */
const DEFAULT_COLLAPSED = 5;

/** View settings live in this browser only: they are a convenience, not shared state. */
function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      // private window or blocked storage: the setting lasts until reload
    }
  };
  return [value, set];
}

/** A value with quotes, as one CSV field: commas and quotes inside it survive. */
const csvField = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** One cell as in a spreadsheet: one line, a fixed width; what does not fit goes under the next cell. */
function Cell({ children, className, ...props }: React.ComponentProps<"td">) {
  return (
    <td className={cn("border-r px-0 py-0", className)} {...props}>
      <div className="w-36 overflow-hidden px-2 py-1 whitespace-nowrap">{children}</div>
    </td>
  );
}

/** «Конвейер»: LS Clicker on every Mac and the operator's table it takes its rows from. */
export function PipelinePage() {
  return (
    <>
      <PageHeader title="Конвейер" description="LS Clicker на всех Mac и ваша таблица строк, которые он берёт по одной." />
      <LsClickerPanel />
      <PipelineTable />
    </>
  );
}

/**
 * The operator's own table (REQ-UI-012): any CSV, shown like a spreadsheet, with the state of the matching
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
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useStored("bap.pipeline.expanded", false);
  const [chosen, setChosen] = useStored<string[] | null>("bap.pipeline.columns", null);
  const [pageSize, setPageSize] = useStored<number>("bap.pipeline.pageSize", 50);
  const [page, setPage] = useState(0);
  const [donePage, setDonePage] = useState(0);
  const table = useQuery({ queryKey: ["pipeline"], queryFn: () => api<Pipeline>("/pipeline"), refetchInterval: 5000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["pipeline"] });

  const upload = useMutation({
    mutationFn: async (f: File) =>
      api<{ rows: number; columns: number }>(`/pipeline/import?name=${encodeURIComponent(f.name)}`, { method: "POST", body: await f.text(), headers: { "content-type": "text/csv" } }),
    onSuccess: (r) => {
      void refresh();
      notifyDone(`Загружено строк: ${r.rows}`, `Колонок: ${r.columns}.`);
    },
    onError: notifyError("Импорт CSV"),
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
  const append = useMutation({
    mutationFn: (cells: string[]) => api<{ added: number }>("/pipeline/rows", { method: "POST", body: JSON.stringify({ text: cells.map(csvField).join(",") }) }),
    onSuccess: () => {
      // The new row is the last one: show the page it is on (the page number is clamped to the last page).
      setPage(Number.MAX_SAFE_INTEGER);
      void refresh();
    },
    onError: notifyError("Добавить строку"),
  });

  const setFrom = useMutation({
    mutationFn: (n: number | null) => api(`/pipeline/lsc-from`, { method: "PUT", body: JSON.stringify({ n }) }),
    onSuccess: () => void refresh(),
    onError: notifyError("Строка, с которой берёт LS Clicker"),
  });

  const imp = table.data?.import ?? null;
  const rows = table.data?.rows ?? [];
  const matched = rows.filter((r) => r.ours).length;
  const shown = rows.find((r) => r.n === open);

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
  const name = (i: number) => imp.columns[i] || `колонка ${i + 1}`;
  const all = imp.columns.map((_, i) => i);
  const collapsedColumns = chosen ? all.filter((i) => chosen.includes(name(i))) : all.slice(0, DEFAULT_COLLAPSED);
  const visible = expanded ? all : collapsedColumns;
  const span = visible.length + 4;
  const status = statusColumn(imp.columns);
  const number = numberColumn(imp.columns);
  /** Why LS Clicker will not take a row it has not taken: its status, or it is above the starting row. */
  const skipped = (r: Pipeline["rows"][number]) => {
    const value = status >= 0 ? (r.cells[status] ?? "").trim().toLowerCase() : "";
    if (DONE_STATUSES.includes(value)) return { text: "пропуск", title: `статус ${value}: не запускается` };
    if (imp.lscFrom && r.n < imp.lscFrom) return { text: "история", title: "история: не запускается" };
    const missing = [number >= 0 && !(r.cells[number] ?? "").trim() && "number", !r.proxy?.trim() && "прокси"].filter(Boolean);
    if (missing.length) return { text: "wait info", title: `ждёт: ${missing.join(" и ")}` };
    return null;
  };
  // Rows with a good or bad status are done, rows above the starting row are history: both move to «result.csv» below.
  const done = (r: Pipeline["rows"][number]) => (status >= 0 && DONE_STATUSES.includes((r.cells[status] ?? "").trim().toLowerCase())) || (!r.lsc && !!imp.lscFrom && r.n < imp.lscFrom);
  const doneRows = rows.filter(done);
  // Rows waiting for their number or proxy come first: they are the ones to fill in.
  const waits = (r: Pipeline["rows"][number]) => !r.lsc && skipped(r)?.text === "wait info";
  const ordered = rows.filter((r) => !done(r)).sort((a, b) => Number(waits(b)) - Number(waits(a)) || a.n - b.n);
  const pages = Math.max(1, Math.ceil(ordered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const donePages = Math.max(1, Math.ceil(doneRows.length / pageSize));
  const doneCurrent = Math.min(donePage, donePages - 1);
  const head = (
    <thead className="sticky top-0 z-10 bg-muted text-muted-foreground">
      <tr>
        <th scope="col" className="border-r px-2 py-1 text-left font-medium">
          #
        </th>
        {[...visible.map(name), "Прокси", "LS Clicker", "Статус профиля"].map((c, i) => (
          <th key={i} scope="col" title={c} className={cn("border-r px-0 py-0 text-left font-medium", i === visible.length && "border-l")}>
            <div className="w-36 truncate px-2 py-1">{c}</div>
          </th>
        ))}
      </tr>
    </thead>
  );
  const line = (r: Pipeline["rows"][number]) => (
    <tr key={r.n} data-testid="pipeline-row" onClick={() => setOpen(r.n)} className={cn("cursor-pointer border-t hover:bg-accent/60", open === r.n && "bg-accent")}>
      <td className="border-r px-2 py-1 text-muted-foreground tabular-nums">
        <button type="button" className="hover:underline" aria-label={`Открыть строку ${r.n}`} onClick={() => setOpen(r.n)}>
          {r.n}
        </button>
      </td>
      {visible.map((i) => (
        <Cell key={i}>{r.cells[i]}</Cell>
      ))}
      <Cell className="border-l font-mono" data-testid="pipeline-proxy">
        {r.proxy ? maskProxy(r.proxy) : <span className="text-muted-foreground">—</span>}
      </Cell>
      <Cell data-testid="pipeline-lsc" title={r.lsc ? `${r.lsc.agentName}: ${r.lsc.result ? "обработана" : "в очереди"}` : (skipped(r)?.title ?? "готова к прогону")}>
        {r.lsc ? `${r.lsc.agentName} · ${r.lsc.result ? "обработана" : "в очереди"}` : <span className="text-muted-foreground">{skipped(r)?.text ?? "готова"}</span>}
      </Cell>
      <Cell>{r.ours ? <StatusBadge status={r.ours.profileStatus} data-testid="pipeline-profile-status" /> : <span className="text-muted-foreground">—</span>}</Cell>
    </tr>
  );
  /** «result.csv»: the done rows as a file of their own, in the table's columns. */
  const downloadResult = () => {
    const text = [imp.columns, ...doneRows.map((r) => r.cells)].map((cells) => cells.map(csvField).join(",")).join("\n") + "\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = "result.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
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
          {/* Rows above the starting row are history: LS Clicker never runs them. */}
          <span className="flex items-center gap-1 text-xs" data-testid="pipeline-lsc-from">
            {imp.lscFrom ? (
              <>
                LS Clicker берёт строки с {imp.lscFrom}-й, выше — история
                <Button variant="link" size="xs" className="h-auto px-1" onClick={() => setFrom.mutate(null)}>
                  брать с первой
                </Button>
              </>
            ) : (
              <>
                LS Clicker берёт строки с первой
                <Button variant="link" size="xs" className="h-auto px-1" onClick={() => setFrom.mutate(Math.max(0, ...rows.map((r) => r.n)) + 1)}>
                  только новые строки
                </Button>
              </>
            )}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
            {expanded ? "Свернуть таблицу" : "Развернуть таблицу"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" />}>
              <Settings2 aria-hidden />
              Настройка
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
              <p className="px-1.5 py-1 text-xs text-muted-foreground">Колонки в свёрнутом виде</p>
              {all.map((i) => (
                <DropdownMenuCheckboxItem
                  key={i}
                  checked={collapsedColumns.includes(i)}
                  onCheckedChange={(on) => {
                    const names = collapsedColumns.map(name);
                    setChosen(on ? [...names, name(i)] : names.filter((n) => n !== name(i)));
                  }}
                >
                  <span className="truncate">{name(i)}</span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus aria-hidden />
            Строки списком
          </Button>
          {pick}
          <a href="/api/v1/pipeline/export" download className={buttonVariants({ variant: "outline" })}>
            <Download aria-hidden />
            Выгрузить CSV
          </a>
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
      <p className="text-xs text-muted-foreground">Нажмите на строку, чтобы увидеть её полностью, изменить и задать прокси. В последней строке можно сразу ввести новую.</p>
      {/* A scrollbar above the table too: a wide table moves sideways without scrolling down to its end first. */}
      <div ref={topBar} aria-hidden data-testid="pipeline-scroll-top" onScroll={() => sync(topBar, box)} className="overflow-x-auto overflow-y-hidden">
        <div style={{ width: wide, height: 1 }} />
      </div>
      <div ref={box} data-testid="pipeline-scroll" onScroll={() => sync(box, topBar)} className="max-h-[calc(100dvh-14rem)] overflow-auto rounded-lg border bg-card">
        <table ref={tableEl} data-testid="pipeline-table" className="w-max min-w-full border-collapse text-xs">
          {head}
          <tbody>
            {ordered.slice(current * pageSize, (current + 1) * pageSize).map(line)}
            <tr className="border-t bg-muted/40">
              <td colSpan={span} className="p-0">
                <Pages id="pipeline-pages" page={current} pages={pages} total={ordered.length} size={pageSize} onPage={setPage} onSize={(n) => {
                    setPageSize(n);
                    setPage(0);
                  }} />
              </td>
            </tr>
            <NewRow columns={imp.columns} visible={visible} onAdd={(cells) => append.mutate(cells)} />
          </tbody>
        </table>
      </div>
      {doneRows.length > 0 && (
        <section aria-label="result.csv" className="grid gap-2" data-testid="pipeline-result">
          <div className="flex items-center gap-2">
            <h2 className="font-mono text-sm font-medium">result.csv</h2>
            <span className="text-xs text-muted-foreground">good, bad и история: {doneRows.length}</span>
            <Button variant="outline" size="sm" className="ml-auto" onClick={downloadResult}>
              <Download aria-hidden />
              Скачать result.csv
            </Button>
          </div>
          <div className="max-h-[calc(100dvh-14rem)] overflow-auto rounded-lg border bg-card">
            <table data-testid="pipeline-result-table" className="w-max min-w-full border-collapse text-xs">
              {head}
              <tbody>
                {doneRows.slice(doneCurrent * pageSize, (doneCurrent + 1) * pageSize).map(line)}
                {donePages > 1 && (
                  <tr className="border-t bg-muted/40">
                    <td colSpan={span} className="p-0">
                      <Pages id="pipeline-result-pages" page={doneCurrent} pages={donePages} total={doneRows.length} size={pageSize} onPage={setDonePage} onSize={setPageSize} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {shown && (
        <RowSheet
          row={shown}
          columns={imp.columns}
          onClose={() => setOpen(null)}
          onSave={(body) => edit.mutate({ n: shown.n, body })}
          onStartHere={() => setFrom.mutate(shown.n)}
          onDelete={async () => {
            if (await confirm({ title: `Удалить строку ${shown.n}?`, description: "Строка удалится из таблицы. Номера остальных строк не изменятся.", action: "Удалить", destructive: true })) remove.mutate(shown.n);
          }}
        />
      )}
      {adding && <AddRows columns={imp.columns} onClose={() => setAdding(false)} onAdded={() => void refresh()} />}
    </section>
  );
}

/** How many rows a page shows and which page is open. */
function Pages({ id, page, pages, total, size, onPage, onSize }: { id: string; page: number; pages: number; total: number; size: number; onPage: (p: number) => void; onSize: (n: number) => void }) {
  return (
    <div className="sticky left-0 flex w-fit items-center gap-2 px-2 py-1.5" data-testid={id}>
      <Label htmlFor={`${id}-size`} className="text-xs text-muted-foreground">
        Строк на странице
      </Label>
      <NativeSelect id={`${id}-size`} size="sm" value={size} onChange={(e) => onSize(Number(e.target.value))} className="w-20">
        {PAGE_SIZES.map((n) => (
          <NativeSelectOption key={n} value={n}>
            {n}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button variant="ghost" size="icon-sm" aria-label="Предыдущая страница" disabled={page === 0} onClick={() => onPage(page - 1)}>
        <ChevronLeft aria-hidden />
      </Button>
      <span className="text-xs tabular-nums">
        {page + 1} из {pages} · всего {total}
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Следующая страница" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}

/**
 * The always-empty last row: what is typed into it becomes a new row once focus leaves the row
 * (filled or not), and a fresh empty row takes its place.
 */
function NewRow({ columns, visible, onAdd }: { columns: string[]; visible: number[]; onAdd: (cells: string[]) => void }) {
  const [draft, setDraft] = useState<string[]>(() => columns.map(() => ""));
  return (
    <tr
      data-testid="pipeline-new-row"
      className="border-t"
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null) || draft.every((v) => !v.trim())) return;
        onAdd(draft);
        setDraft(columns.map(() => ""));
      }}
    >
      <td className="border-r px-2 py-1 text-muted-foreground">
        <Plus className="size-3.5" aria-hidden />
      </td>
      {visible.map((i) => (
        <td key={i} className="border-r p-0">
          <input
            aria-label={`Новая строка: ${columns[i] || `колонка ${i + 1}`}`}
            value={draft[i]}
            onChange={(e) => setDraft(draft.map((v, j) => (j === i ? e.target.value : v)))}
            className="w-36 bg-transparent px-2 py-1 outline-none focus:bg-accent/60"
          />
        </td>
      ))}
      <td colSpan={3} className="border-l" />
    </tr>
  );
}

/** One row in full: every field editable, the proxy, and what BAP and LS Clicker know about it. */
function RowSheet({
  row: r,
  columns,
  onClose,
  onSave,
  onDelete,
  onStartHere,
}: {
  row: Pipeline["rows"][number];
  columns: string[];
  onClose: () => void;
  onSave: (body: { cells?: string[]; proxy?: string }) => void;
  onDelete: () => void;
  onStartHere: () => void;
}) {
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
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={onStartHere}>
                <Play aria-hidden />
                LS Clicker — с этой строки
              </Button>
              <Button variant="outline" className="text-fail" onClick={onDelete}>
                <Trash2 aria-hidden />
                Удалить строку
              </Button>
            </div>
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

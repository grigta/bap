import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { BookMarked, Plus, Send, Trash2, Wand2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useConfirm } from "@/components/confirm";
import { type Column, DataTable, columns } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/layout/app-shell";
import { HttpError, api } from "@/lib/api";
import { time } from "@/lib/format";
import { notifyError } from "@/lib/notify";
import type { Profile, RecipeBody, RecipeStep, RecipeSummary, RecipeVersion } from "@/lib/types";
import { cn } from "@/lib/utils";

const ORIGIN: Record<RecipeVersion["origin"], string> = { bundle: "код", manual: "вручную", recorded: "записан", healed: "вылечен" };

interface InputRow {
  name: string;
  value: string;
  secret: boolean;
}

/** A task for a site the system has not seen: the recipe is recorded on one of the profiles. */
function NewTask({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: () => api<Profile[]>("/profiles"), enabled: open, refetchInterval: open ? 2000 : false });
  const [id, setId] = useState("");
  const [goal, setGoal] = useState("");
  const [startUrl, setStartUrl] = useState("https://");
  const [profileId, setProfileId] = useState("");
  const [rows, setRows] = useState<InputRow[]>([{ name: "", value: "", secret: false }]);
  const setRow = (i: number, patch: Partial<InputRow>) => setRows((all) => all.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  const create = useMutation({
    mutationFn: (body: object) => api<{ recipeId: string; runId: string }>("/recipes", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: ({ runId }) => {
      void queryClient.invalidateQueries({ queryKey: ["recipes"] });
      onOpenChange(false);
      navigate({ to: "/runs/$runId", params: { runId }, search: {} });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const filled = rows.filter((r) => r.name.trim());
    create.mutate({
      id,
      goal,
      startUrl,
      profileId,
      inputs: filled.map((r) => ({ name: r.name.trim(), secret: r.secret })),
      input: Object.fromEntries(filled.map((r) => [r.name.trim(), r.value])),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle>Новая задача на сайте</DialogTitle>
        <DialogDescription>Система пройдёт сайт сама и запишет рецепт. Перед каждым действием, которое меняет данные на сайте, она спросит подтверждение.</DialogDescription>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="task-id">Название</Label>
              <Input id="task-id" value={id} onChange={(e) => setId(e.target.value)} required pattern="[a-z0-9][a-z0-9\-]*" placeholder="shop-order" title="Латиница в нижнем регистре, цифры и дефис" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-profile">Профиль</Label>
              <NativeSelect id="task-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} required className="w-full">
                <NativeSelectOption value="">Выберите</NativeSelectOption>
                {profiles.data?.map((p) => (
                  <NativeSelectOption key={p.id} value={p.id} disabled={!p.assignable}>
                    {p.assignable ? p.name : `${p.name} (${p.status})`}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-goal">Цель</Label>
            <Textarea id="task-goal" value={goal} onChange={(e) => setGoal(e.target.value)} required rows={2} placeholder="Оформить заказ товара {{input.item}} с доставкой по адресу {{input.address}}" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="task-url">Стартовый адрес</Label>
            <Input id="task-url" type="url" value={startUrl} onChange={(e) => setStartUrl(e.target.value)} required />
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-sm font-medium">Входные данные</legend>
            {rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_1.5fr_auto_auto] items-center gap-2">
                <Input aria-label={`Поле ${i + 1}: имя`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} placeholder="item" pattern="[A-Za-z_][\w\-]*" />
                <Input aria-label={`Поле ${i + 1}: значение`} type={r.secret ? "password" : "text"} value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="значение" />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Checkbox aria-label={`Поле ${i + 1}: секрет`} checked={r.secret} onCheckedChange={(checked) => setRow(i, { secret: checked === true })} />
                  секрет
                </label>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={`Удалить поле ${i + 1}`} onClick={() => setRows((all) => all.filter((_, k) => k !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setRows((all) => [...all, { name: "", value: "", secret: false }])}>
              <Plus aria-hidden />
              Поле
            </Button>
            <p className="text-xs text-muted-foreground">Секретные значения не попадают ни в рецепт, ни в журналы, ни в снимки страниц.</p>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={create.isPending}>
              <Wand2 aria-hidden />
              Записать
            </Button>
            {create.error instanceof HttpError && (
              <p role="alert" className="text-sm text-fail">
                {create.error.code ?? `HTTP ${create.error.status}`}: {create.error.message}
              </p>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function describeStep(s: RecipeStep): string {
  const target = s.target ? `${s.target.role} «${s.target.name || s.target.text}»` : "";
  switch (s.action) {
    case "navigate":
      return `открыть ${s.value}`;
    case "fill":
      return `ввести ${s.value} в ${target}`;
    case "select":
      return `выбрать ${s.value} в ${target}`;
    case "press":
      return `нажать клавишу ${s.value}`;
    case "wait":
      return `подождать ${s.value} мс`;
    case "extract":
      return `прочитать ${target} в ${s.value}`;
    default:
      return `нажать ${target}`;
  }
}

function RecipeDetail({ recipe, version }: { recipe: RecipeSummary; version?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const current = recipe.versions.find((v) => v.version === version) ?? recipe.versions.at(-1);
  const body = useQuery({
    queryKey: ["recipe", recipe.id, current?.version],
    queryFn: () => api<{ recipe: RecipeBody }>(`/recipes/${recipe.id}/versions/${current!.version}`),
    enabled: !!current,
  });
  const publish = useMutation({
    mutationFn: (v: string) => api(`/recipes/${recipe.id}/versions/${v}/publish`, { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
    onError: notifyError("Публикация"),
  });
  const askPublish = async (v: RecipeVersion) => {
    if (await confirm({ title: `Опубликовать ${recipe.id} ${v.version}?`, description: "Опубликованный рецепт выполняется в обычных заданиях без подтверждений, в том числе шаги, которые меняют данные на сайте.", action: "Опубликовать" }))
      publish.mutate(v.version);
  };

  return (
    <section data-testid="recipe-detail" className="mb-6 rounded-lg border bg-card">
      <header className="border-b p-4">
        <h2 className="text-base font-semibold">{recipe.id}</h2>
        <p className="mt-1 text-sm">{recipe.goal}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {recipe.startUrl}
          {recipe.inputs.length > 0 && `, входные данные: ${recipe.inputs.map((i) => (i.secret ? `${i.name} (секрет)` : i.name)).join(", ")}`}
        </p>
      </header>
      <div className="grid gap-4 p-4 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="Версии">
          <ol className="grid gap-1">
            {recipe.versions.map((v) => (
              <li key={v.version}>
                <Link
                  to="/recipes/$recipeId"
                  params={{ recipeId: recipe.id }}
                  search={{ version: v.version }}
                  data-testid={`version-${v.version}`}
                  className={cn("grid gap-0.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-accent", v.version === current?.version && "border-primary bg-accent")}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {v.version}
                    <span className="text-muted-foreground">{ORIGIN[v.origin]}</span>
                    <span className={cn("ml-auto rounded-sm px-1 text-[10px]", v.publishedAt ? "bg-ok-soft text-ok" : "bg-wait-soft text-wait")}>{v.publishedAt ? "опубликован" : "черновик"}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">{time(v.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>
        <div className="min-w-0">
          {current && (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              {current.sourceRunId && (
                <Link to="/runs/$runId" params={{ runId: current.sourceRunId }} search={{}} className="text-xs hover:underline">
                  {current.origin === "healed" ? "Задание, в котором шаги вылечены" : "Задание записи"}
                </Link>
              )}
              {current.note && <p className="text-xs text-muted-foreground">Что изменилось: {current.note}</p>}
              {!current.publishedAt && (
                <Button size="sm" className="ml-auto" onClick={() => askPublish(current)}>
                  <Send aria-hidden />
                  Опубликовать
                </Button>
              )}
            </div>
          )}
          <ol className="grid gap-2" aria-label="Шаги рецепта">
            {body.data?.recipe.steps.map((s, i) => (
              <li key={s.id} data-testid={`recipe-step-${s.id}`} className="flex gap-3 rounded-md border bg-background p-2">
                {s.screenshot ? (
                  <a href={`/api/v1/recipes/${recipe.id}/screenshots/${s.screenshot}`} target="_blank" rel="noreferrer" className="block w-40 shrink-0 overflow-hidden rounded-sm border bg-muted">
                    <img src={`/api/v1/recipes/${recipe.id}/screenshots/${s.screenshot}`} alt={`Шаг ${i + 1}: ${s.intent}`} className="aspect-[16/10] w-full object-cover object-top" loading="lazy" />
                  </a>
                ) : (
                  <span className="grid aspect-[16/10] w-40 shrink-0 place-items-center rounded-sm border bg-muted text-[10px] text-muted-foreground">без скриншота</span>
                )}
                <div className="grid min-w-0 content-start gap-1 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {i + 1}. {s.intent}
                    {s.mutating && <span className="rounded-sm bg-wait-soft px-1 text-[10px] font-normal text-wait">меняет данные</span>}
                  </div>
                  <p className="text-muted-foreground">{describeStep(s)}</p>
                  {s.target?.context && <p className="truncate text-muted-foreground">рядом: «{s.target.context}»</p>}
                  {s.postcondition && (
                    <p className="text-muted-foreground">
                      проверка: {[s.postcondition.url && `адрес содержит ${s.postcondition.url}`, s.postcondition.text && `на странице «${s.postcondition.text}»`].filter(Boolean).join(", ")}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <div className="flex justify-end border-t p-2">
        <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/recipes" })}>
          Закрыть
        </Button>
      </div>
    </section>
  );
}

/** Recipes: recorded solutions of tasks on sites, replayed by the Macs on their own. */
export function RecipesPage({ recipeId, version }: { recipeId?: string; version?: string }) {
  const [creating, setCreating] = useState(false);
  const recipes = useQuery({ queryKey: ["recipes"], queryFn: () => api<RecipeSummary[]>("/recipes"), refetchInterval: 3000 });
  const selected = recipes.data?.find((r) => r.id === recipeId);

  const c = columns<RecipeSummary>();
  const cols: Column<RecipeSummary>[] = [
    c.accessor("id", {
      header: "Рецепт",
      cell: (i) => (
        <Link to="/recipes/$recipeId" params={{ recipeId: i.getValue() }} search={{}} className="font-medium hover:underline">
          {i.getValue()}
        </Link>
      ),
    }),
    c.accessor("goal", { header: "Цель", enableSorting: false, cell: (i) => <span className="line-clamp-1 max-w-md">{i.getValue()}</span> }),
    c.accessor((r) => r.versions.filter((v) => v.publishedAt).at(-1)?.version ?? "", {
      id: "published",
      header: "Опубликован",
      cell: (i) => <span className="tabular-nums">{i.getValue() || "—"}</span>,
    }),
    c.accessor((r) => r.versions.filter((v) => !v.publishedAt).length, {
      id: "drafts",
      header: "Черновики",
      cell: (i) => <span className="tabular-nums">{i.getValue() || "—"}</span>,
    }),
    c.accessor((r) => r.lastRecording?.status ?? "", {
      id: "recording",
      header: "Запись",
      cell: (i) => {
        const rec = i.row.original.lastRecording;
        return rec ? (
          <Link to="/runs/$runId" params={{ runId: rec.runId }} search={{}}>
            <StatusBadge status={rec.status} />
          </Link>
        ) : (
          "—"
        );
      },
    }),
  ];

  return (
    <>
      <PageHeader
        title="Рецепты"
        description="Задачи для любого сайта. Система записывает решение один раз, а затем Mac выполняют его сами и подстраиваются под изменения вёрстки."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus aria-hidden />
            Новая задача на сайте
          </Button>
        }
      />
      <NewTask open={creating} onOpenChange={setCreating} />
      {selected && <RecipeDetail key={selected.id} recipe={selected} version={version} />}
      {recipes.data?.length === 0 && <EmptyState icon={BookMarked} title="Рецептов пока нет" description="Опишите задачу и стартовый адрес — система пройдёт сайт и запишет рецепт." />}
      {!!recipes.data?.length && <DataTable id="recipes" data={recipes.data} columns={cols} rowTestId={(r) => `recipe-${r.id}`} rowClassName={(r) => (r.id === recipeId ? "bg-accent/60" : undefined)} />}
    </>
  );
}

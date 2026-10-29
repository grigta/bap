import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const REQ_ID = /REQ-[A-Z]+-\d{3}/g;
const REQ_DEFINITION = /^- \*\*(REQ-[A-Z]+-\d{3})\*\* — (.+)$/gm;
const ADR_REF = /ADR-(\d{4})/g;
const MD_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;

const stageSchema = z.object({
  id: z.string().regex(/^S\d+$/),
  title: z.string().min(1),
  status: z.enum(["planned", "in-progress", "done"]),
  depends_on: z.array(z.string().regex(/^S\d+$/)).default([]),
  reqs: z.array(z.string().regex(/^REQ-[A-Z]+-\d{3}$/)).min(1),
});

export type Stage = z.infer<typeof stageSchema> & { file: string };
export type TestStatus = "passed" | "failed" | "skipped";
export interface TestResult {
  name: string;
  status: TestStatus;
  reqs: string[];
}
export interface Requirement {
  id: string;
  text: string;
  file: string;
}
export interface Report {
  errors: string[];
  requirements: Requirement[];
  stages: Stage[];
  /** null when no JUnit reports were found */
  tests: TestResult[] | null;
}

export const STATUS_FILE = "docs/STATUS.md";

/** `generating`: STATUS.md is about to be (re)written, so links to it count as valid. */
export function check(root: string, { junitDir = join(root, "reports/junit"), generating = false } = {}): Report {
  const docs = join(root, "docs");
  if (!existsSync(docs))
    return { errors: ["нет папки docs/ — документация живёт в приватном репозитории, склонируй его в docs/"], requirements: [], stages: [], tests: null };
  const errors: string[] = [];
  const rel = (p: string) => relative(root, p);

  const files = listFiles(docs).filter((f) => f.endsWith(".md"));
  const texts = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

  const requirements: Requirement[] = [];
  for (const file of files.filter((f) => f.startsWith(join(docs, "prd") + "/"))) {
    for (const m of texts.get(file)!.matchAll(REQ_DEFINITION)) {
      const dup = requirements.find((r) => r.id === m[1]);
      if (dup) errors.push(`${rel(file)}: ${m[1]} уже определено в ${rel(dup.file)}`);
      else requirements.push({ id: m[1]!, text: m[2]!, file });
    }
  }
  const reqIds = new Set(requirements.map((r) => r.id));

  const stages: Stage[] = [];
  for (const file of files.filter((f) => /^S\d+-.+\.md$/.test(basename(f)) && dirname(f) === join(docs, "stages"))) {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(texts.get(file)!);
    if (!fm) {
      errors.push(`${rel(file)}: нет frontmatter`);
      continue;
    }
    const parsed = stageSchema.safeParse(parseYaml(fm[1]!));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${rel(file)}: frontmatter.${issue.path.join(".")}: ${issue.message}`);
      continue;
    }
    const stage = { ...parsed.data, file };
    if (Number(basename(file).slice(1, basename(file).indexOf("-"))) !== Number(stage.id.slice(1)))
      errors.push(`${rel(file)}: id ${stage.id} не совпадает с именем файла`);
    if (stages.some((s) => s.id === stage.id)) errors.push(`${rel(file)}: повторный id ${stage.id}`);
    stages.push(stage);
  }
  stages.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const stageById = new Map(stages.map((s) => [s.id, s]));

  for (const s of stages) {
    for (const r of s.reqs) if (!reqIds.has(r)) errors.push(`${rel(s.file)}: ${r} не определено в docs/prd`);
    for (const d of s.depends_on) if (!stageById.has(d)) errors.push(`${rel(s.file)}: depends_on ${d} — нет такой стадии`);
  }
  for (const r of requirements)
    if (!stages.some((s) => s.reqs.includes(r.id))) errors.push(`${rel(r.file)}: ${r.id} не закреплено ни за одной стадией`);

  for (const [file, text] of texts) {
    // The old STATUS.md is about to be replaced: what it says no longer counts.
    if (generating && file === join(root, STATUS_FILE)) continue;
    const prose = stripCode(text);
    for (const m of prose.matchAll(REQ_ID))
      if (!reqIds.has(m[0])) errors.push(`${rel(file)}: ссылка на несуществующее ${m[0]}`);
    for (const m of prose.matchAll(ADR_REF))
      if (!existsSync(join(docs, "adr")) || !readdirSync(join(docs, "adr")).some((f) => f.startsWith(`${m[1]}-`)))
        errors.push(`${rel(file)}: ссылка на несуществующий ADR-${m[1]}`);
    for (const m of prose.matchAll(MD_LINK)) {
      const target = m[1]!;
      if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
      const path = resolve(dirname(file), decodeURI(target.split("#")[0]!));
      if (!existsSync(path) && !(generating && path === join(root, STATUS_FILE))) errors.push(`${rel(file)}: битая ссылка ${target}`);
    }
  }

  const tests = readJunit(junitDir);
  for (const t of tests ?? [])
    for (const r of t.reqs) if (!reqIds.has(r)) errors.push(`тест «${t.name}»: тег ${r} — нет такого требования`);

  for (const s of stages.filter((s) => s.status === "done")) {
    if (!tests) {
      errors.push(`${rel(s.file)}: стадия done, но нет отчётов тестов в ${rel(junitDir)} — запусти pnpm verify`);
      continue;
    }
    for (const r of s.reqs)
      if (!tests.some((t) => t.status === "passed" && t.reqs.includes(r)))
        errors.push(`${rel(s.file)}: стадия done, но ${r} не покрыто ни одним прошедшим тестом`);
    if (evidenceFiles(docs, s.id).length === 0)
      errors.push(`${rel(s.file)}: стадия done, но нет доказательств в docs/evidence/${s.id}/`);
    for (const d of s.depends_on)
      if (stageById.get(d) && stageById.get(d)!.status !== "done")
        errors.push(`${rel(s.file)}: стадия done, но зависимость ${d} не done`);
  }

  return { errors, requirements, stages, tests };
}

export function renderStatus(report: Report): string {
  const { requirements, stages } = report;
  if (!report.tests) throw new Error("renderStatus: нет отчётов тестов — сначала запусти тесты");
  const passed = (id: string) =>
    [...new Set(report.tests!.filter((t) => t.status === "passed" && t.reqs.includes(id)).map((t) => t.name))].sort();
  const covered = requirements.filter((r) => passed(r.id).length > 0).length;
  const docs = dirname(dirname(stages[0]?.file ?? requirements[0]!.file));

  const lines = [
    "# Статус разработки",
    "",
    "<!-- Генерируется `pnpm docs:status`. Не редактировать вручную. -->",
    "",
    `Требований: ${requirements.length}, покрыто прошедшими тестами: ${covered}.`,
    "",
    "## Стадии",
    "",
    "| Стадия | Название | Статус | Покрыто требований | Доказательства |",
    "|---|---|---|---|---|",
    ...stages.map((s) => {
      const n = s.reqs.filter((r) => passed(r).length > 0).length;
      const ev = evidenceFiles(docs, s.id).length;
      const link = `[${s.id}](./stages/${basename(s.file)})`;
      return `| ${link} | ${s.title} | ${s.status} | ${n}/${s.reqs.length} | ${ev ? `[${ev} файл(ов)](./evidence/${s.id}/)` : "—"} |`;
    }),
    "",
    "## Требования",
    "",
    "| Требование | Стадии | Прошедшие тесты |",
    "|---|---|---|",
    ...requirements.map((r) => {
      const st = stages.filter((s) => s.reqs.includes(r.id)).map((s) => s.id).join(", ");
      const t = passed(r.id);
      return `| [${r.id}](./prd/${basename(r.file)}) | ${st} | ${t.length ? t.map((x) => `\`${x.replace(/\|/g, "\\|")}\``).join("<br>") : "—"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

function readJunit(dir: string): TestResult[] | null {
  if (!existsSync(dir)) return null;
  const xmls = readdirSync(dir).filter((f) => f.endsWith(".xml"));
  if (xmls.length === 0) return null;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => name === "testsuite" || name === "testcase",
  });
  const results: TestResult[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "testcase") {
        for (const tc of value as Record<string, unknown>[]) {
          const name = String(tc.name);
          const status: TestStatus = "failure" in tc || "error" in tc ? "failed" : "skipped" in tc ? "skipped" : "passed";
          results.push({ name, status, reqs: [...name.matchAll(REQ_ID)].map((m) => m[0]) });
        }
      } else if (Array.isArray(value)) value.forEach(visit);
      else visit(value);
    }
  };
  for (const f of xmls) visit(parser.parse(readFileSync(join(dir, f), "utf8")));
  return results;
}

function evidenceFiles(docs: string, id: string): string[] {
  const dir = join(docs, "evidence", id);
  return existsSync(dir) ? listFiles(dir).filter((f) => !basename(f).startsWith(".")) : [];
}

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

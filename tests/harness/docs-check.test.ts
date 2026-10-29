import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { check, renderStatus } from "../../tools/docs-check/src/index.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const roots: string[] = [];

type Files = Record<string, string>;

function stage(id: string, status: string, reqs: string[], dependsOn: string[] = []): string {
  return `---\nid: ${id}\ntitle: "Stage ${id}"\nstatus: ${status}\ndepends_on: [${dependsOn.join(", ")}]\nreqs:\n${reqs.map((r) => `  - ${r}\n`).join("")}---\n\n# ${id}\n`;
}

function junit(cases: { name: string; result?: "failure" | "skipped" }[]): string {
  const body = cases
    .map((c) => `<testcase name="${c.name}">${c.result ? `<${c.result}/>` : ""}</testcase>`)
    .join("");
  return `<?xml version="1.0"?><testsuites><testsuite name="s">${body}</testsuite></testsuites>`;
}

const validFiles: Files = {
  "docs/prd/01-a.md": "# A\n\n## Требования\n\n- **REQ-A-001** — first.\n- **REQ-A-002** — second, see [B](./02-b.md).\n",
  "docs/prd/02-b.md": "# B\n\n## Требования\n\n- **REQ-B-001** — third, decided in ADR-0001.\n",
  "docs/adr/0001-x.md": "# ADR-0001: x\n",
  "docs/stages/S00-first.md": stage("S0", "done", ["REQ-A-001"]),
  "docs/stages/S01-second.md": stage("S1", "planned", ["REQ-A-002", "REQ-B-001"], ["S0"]),
  "docs/evidence/S0/screen.png": "png",
  "reports/junit/unit.xml": junit([{ name: "[REQ-A-001] does the first thing" }]),
};

function fixture(overrides: Files = {}, remove: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "docs-check-"));
  roots.push(root);
  const files = { ...validFiles, ...overrides };
  for (const r of remove) delete files[r];
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("docs:check", () => {
  test("valid documentation passes", () => {
    const report = check(fixture());
    expect(report.errors).toEqual([]);
    expect(report.requirements.map((r) => r.id)).toEqual(["REQ-A-001", "REQ-A-002", "REQ-B-001"]);
    expect(report.stages.map((s) => s.id)).toEqual(["S0", "S1"]);
  });

  // Each injected fault must be reported with a message naming the problem.
  test.each<[string, Files, string[], RegExp]>([
    ["broken relative link", { "docs/prd/02-b.md": "# B\n\n[x](./missing.md)\n\n## Требования\n\n- **REQ-B-001** — t.\n" }, [], /битая ссылка \.\/missing\.md/],
    ["requirement without a stage", { "docs/prd/02-b.md": "# B\n\n## Требования\n\n- **REQ-B-001** — t.\n- **REQ-B-002** — orphan.\n" }, [], /REQ-B-002 не закреплено ни за одной стадией/],
    ["duplicate requirement", { "docs/prd/02-b.md": "# B\n\n## Требования\n\n- **REQ-B-001** — t.\n- **REQ-A-001** — dup.\n" }, [], /REQ-A-001 уже определено/],
    ["stage references unknown requirement", { "docs/stages/S01-second.md": stage("S1", "planned", ["REQ-A-002", "REQ-B-001", "REQ-Z-999"], ["S0"]) }, [], /REQ-Z-999 не определено в docs\/prd/],
    ["prose references unknown requirement", { "docs/adr/0001-x.md": "# ADR-0001: x\n\nсм. REQ-Q-123\n" }, [], /ссылка на несуществующее REQ-Q-123/],
    ["unknown ADR", { "docs/prd/01-a.md": "# A\n\nсм. ADR-0042\n\n## Требования\n\n- **REQ-A-001** — f.\n- **REQ-A-002** — s.\n" }, [], /несуществующий ADR-0042/],
    ["test tagged with unknown requirement", { "reports/junit/unit.xml": junit([{ name: "[REQ-A-001] ok" }, { name: "[REQ-NOPE-001] ghost" }]) }, [], /тег REQ-NOPE-001 — нет такого требования/],
    ["done stage without evidence", {}, ["docs/evidence/S0/screen.png"], /нет доказательств в docs\/evidence\/S0/],
    ["done stage with failed test only", { "reports/junit/unit.xml": junit([{ name: "[REQ-A-001] x", result: "failure" }]) }, [], /REQ-A-001 не покрыто ни одним прошедшим тестом/],
    ["done stage with skipped test only", { "reports/junit/unit.xml": junit([{ name: "[REQ-A-001] x", result: "skipped" }]) }, [], /REQ-A-001 не покрыто ни одним прошедшим тестом/],
    ["done stage without test reports", {}, ["reports/junit/unit.xml"], /нет отчётов тестов/],
    ["done stage with unfinished dependency", { "docs/stages/S01-second.md": stage("S1", "done", ["REQ-A-002", "REQ-B-001"], ["S0", "S0"]), "docs/stages/S00-first.md": stage("S0", "in-progress", ["REQ-A-001"]) }, [], /зависимость S0 не done/],
    ["unknown dependency", { "docs/stages/S01-second.md": stage("S1", "planned", ["REQ-A-002", "REQ-B-001"], ["S7"]) }, [], /depends_on S7 — нет такой стадии/],
    ["invalid status", { "docs/stages/S01-second.md": stage("S1", "finished", ["REQ-A-002", "REQ-B-001"]) }, [], /frontmatter\.status/],
    ["missing frontmatter", { "docs/stages/S01-second.md": "# S1\n" }, [], /нет frontmatter/],
    ["id does not match file name", { "docs/stages/S01-second.md": stage("S2", "planned", ["REQ-A-002", "REQ-B-001"]) }, [], /id S2 не совпадает с именем файла/],
    ["duplicate stage id", { "docs/stages/S00-dup.md": stage("S0", "planned", ["REQ-A-001"]) }, [], /повторный id S0/],
  ])("reports %s", (_name, overrides, remove, message) => {
    const { errors } = check(fixture(overrides, remove));
    expect(errors.some((e) => message.test(e)), errors.join("\n")).toBe(true);
  });

  test("fails loudly when docs/ is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "docs-check-"));
    roots.push(root);
    expect(check(root).errors).toEqual([expect.stringMatching(/нет папки docs\//)]);
  });

  test("ignores references inside code", () => {
    const root = fixture({ "docs/README.md": "# R\n\n`REQ-X-000` and `[x](./nope.md)` in code:\n\n```md\nREQ-Y-000 [y](./nope.md)\n```\n" });
    expect(check(root).errors).toEqual([]);
  });

  test("accepts external links, anchors and one test covering several requirements", () => {
    const root = fixture({
      "docs/README.md": "# R\n\n[ext](https://example.com) [a](#top) [b](./prd/01-a.md#x)\n",
      "reports/junit/unit.xml": junit([{ name: "[REQ-A-001][REQ-B-001] both" }]),
    });
    const report = check(root);
    expect(report.errors).toEqual([]);
    expect(report.tests).toEqual([{ name: "[REQ-A-001][REQ-B-001] both", status: "passed", reqs: ["REQ-A-001", "REQ-B-001"] }]);
  });

  test("renders STATUS.md deterministically from stages and passed tests", () => {
    const root = fixture({
      "reports/junit/unit.xml": junit([{ name: "[REQ-A-001] b" }, { name: "[REQ-A-001] a" }, { name: "[REQ-B-001] failing", result: "failure" }]),
    });
    const status = renderStatus(check(root));
    expect(status).toContain("Требований: 3, покрыто прошедшими тестами: 1.");
    expect(status).toContain("| [S0](./stages/S00-first.md) | Stage S0 | done | 1/1 | [1 файл(ов)](./evidence/S0/) |");
    expect(status).toContain("| [S1](./stages/S01-second.md) | Stage S1 | planned | 0/2 | — |");
    expect(status).toContain("| [REQ-A-001](./prd/01-a.md) | S0 | `[REQ-A-001] a`<br>`[REQ-A-001] b` |");
    expect(status).toContain("| [REQ-B-001](./prd/02-b.md) | S1 | — |");
    expect(renderStatus(check(root))).toBe(status);
  });

  test("refuses to render status without test reports", () => {
    const root = fixture({ "docs/stages/S00-first.md": stage("S0", "planned", ["REQ-A-001"]) }, ["reports/junit/unit.xml"]);
    expect(() => renderStatus(check(root))).toThrow(/нет отчётов тестов/);
  });
});

describe("docs:check CLI", () => {
  const cli = join(repoRoot, "tools/docs-check/src/cli.ts");

  test("exits 1 and lists errors", () => {
    const root = fixture({}, ["docs/evidence/S0/screen.png"]);
    const run = spawnSync("node", [cli, "--root", root], { encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/✗ docs\/stages\/S00-first\.md: стадия done, но нет доказательств/);
  });

  test("writes STATUS.md with --write-status", () => {
    const root = fixture();
    const out = execFileSync("node", [cli, "--root", root, "--write-status"], { encoding: "utf8" });
    expect(out).toMatch(/docs:check — OK: требований 3, стадий 2, тестов в отчётах: 1/);
    expect(readFileSync(join(root, "docs/STATUS.md"), "utf8")).toContain("# Статус разработки");
  });

  test("links to STATUS.md are broken until it is generated", () => {
    const root = fixture({ "docs/README.md": "# R\n\n[status](./STATUS.md)\n" });
    expect(spawnSync("node", [cli, "--root", root], { encoding: "utf8" }).stderr).toMatch(/битая ссылка \.\/STATUS\.md/);
    execFileSync("node", [cli, "--root", root, "--write-status"]);
    expect(spawnSync("node", [cli, "--root", root]).status).toBe(0);
  });

  test("a STATUS.md that still names a removed requirement is regenerated, not blocking", () => {
    const root = fixture({ "docs/STATUS.md": "# Статус разработки\n\n- REQ-OLD-001\n" });
    expect(spawnSync("node", [cli, "--root", root], { encoding: "utf8" }).stderr).toMatch(/ссылка на несуществующее REQ-OLD-001/);
    execFileSync("node", [cli, "--root", root, "--write-status"]);
    expect(readFileSync(join(root, "docs/STATUS.md"), "utf8")).not.toContain("REQ-OLD-001");
  });
});

describe("coverage gate", () => {
  test("vitest fails when coverage is below the repository thresholds", () => {
    const dir = join(repoRoot, "tests/harness/fixtures/low-coverage");
    const run = spawnSync(join(repoRoot, "node_modules/.bin/vitest"), ["run", "--root", dir, "--coverage"], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toMatch(/Coverage for (lines|functions|statements|branches) \(\d+(\.\d+)?%\) does not meet global threshold \(80%\)/);
  }, 60_000);
});

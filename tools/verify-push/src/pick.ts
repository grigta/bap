// Which integration and e2e tests a change needs before a push: the changed tests themselves and the tests named
// like a changed file (`pipeline-table.tsx` → `pipeline.test.ts`, `pipeline.spec.ts`). Everything else runs in CI.
const stem = (path: string) => (path.split("/").at(-1) ?? "").replace(/\.(test|spec)\.ts$/, "").replace(/\.[^.]+$/, "");
const related = (a: string, b: string) => a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);

export function pick(changed: string[], tests: string[]): string[] {
  const stems = changed.map(stem).filter(Boolean);
  return tests.filter((t) => changed.includes(t) || stems.some((s) => related(s, stem(t))));
}

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { STATUS_FILE, check, renderStatus } from "./index.ts";

const args = process.argv.slice(2);
const root = resolve(args.includes("--root") ? args[args.indexOf("--root") + 1]! : process.cwd());
const writeStatus = args.includes("--write-status");
const report = check(root, { generating: writeStatus });

if (report.errors.length > 0) {
  console.error(`docs:check — ошибок: ${report.errors.length}`);
  for (const e of report.errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}

if (writeStatus) {
  writeFileSync(join(root, STATUS_FILE), renderStatus(report));
  console.log(`docs:status — ${STATUS_FILE} обновлён`);
}
const coverage = report.tests ? `, тестов в отчётах: ${report.tests.length}` : ", отчётов тестов нет";
console.log(`docs:check — OK: требований ${report.requirements.length}, стадий ${report.stages.length}${coverage}`);

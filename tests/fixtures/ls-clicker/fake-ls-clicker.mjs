#!/usr/bin/env node
// A stand-in for ls-clicker in tests: the same files and arguments, no browser and no real sites.
// --find-number --first-row takes the next unprocessed input row (row N of output = row N of input).
// FAKE_LS_MS sets how long a row takes; a row whose first cell is "fail" exits with code 1.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const arg = process.argv[2];
const version = "fake-ls-clicker 1.0";
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()) : []);
if (arg === "--version") {
  console.log(version);
  process.exit(0);
}
if (arg === "--plan") {
  writeFileSync("plan.json", JSON.stringify({ businessDetails: { "Legal business name": "next row" } }));
  process.exit(0);
}
if (arg !== "--find-number") process.exit(2);
const input = lines("input.csv");
const done = Math.max(lines("output.csv").length - 1, 0);
const row = input[1 + done];
if (!row) {
  console.log("нет необработанных строк");
  process.exit(0);
}
const first = row.split(",")[0];
console.log(`строка ${done + 1}: начинаю`);
writeFileSync("state.json", JSON.stringify({ node: "businessDetails", errors: [], ts: Date.now() / 1000, url: "https://qbo.example/businessdetails" }));
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LS_MS ?? 300)));
if (first === "fail") {
  console.log("ошибка: форма не принята");
  process.exit(1);
}
const out = existsSync("output.csv") ? readFileSync("output.csv", "utf8") : "who,result\n";
writeFileSync("output.csv", `${out}${first},registered\n`);
console.log(`строка ${done + 1}: готово`);

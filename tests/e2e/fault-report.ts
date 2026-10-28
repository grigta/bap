// Playwright reporter for tests/e2e/fault-suite.spec.ts: one self-contained HTML page with a row per
// fault case — what was broken, what was expected, what was observed, panel screenshots — and its verdict.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const OUT = resolve(import.meta.dirname, "../../reports/fault-suite/index.html");
const EVIDENCE = resolve(import.meta.dirname, "../../docs/evidence/S9/fault-suite.html");

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

interface Row {
  title: string;
  status: TestResult["status"];
  durationMs: number;
  notes: Record<string, string>;
  shots: { name: string; dataUrl: string }[];
  error?: string;
}

export default class FaultReport implements Reporter {
  private rows: Row[] = [];

  onTestEnd(test: TestCase, result: TestResult) {
    if (!test.location.file.endsWith("fault-suite.spec.ts")) return;
    const notes = Object.fromEntries(test.annotations.filter((a) => a.description).map((a) => [a.type, a.description!]));
    const shots = result.attachments
      .filter((a) => a.contentType === "image/png" && (a.body || a.path))
      .map((a) => ({ name: a.name, dataUrl: `data:image/png;base64,${(a.body ?? readFileSync(a.path!)).toString("base64")}` }));
    this.rows.push({ title: test.title, status: result.status, durationMs: result.duration, notes, shots, error: result.error?.message });
  }

  onEnd() {
    if (this.rows.length === 0) return;
    const passed = this.rows.filter((r) => r.status === "passed").length;
    const rows = this.rows
      .map(
        (r) => `<tr class="${r.status === "passed" ? "ok" : "bad"}">
  <td><b>${esc(r.title)}</b><div class="verdict">${r.status === "passed" ? "PASS" : r.status.toUpperCase()} · ${(r.durationMs / 1000).toFixed(1)} с</div></td>
  <td>${esc(r.notes.broke ?? "")}</td>
  <td>${esc(r.notes.expected ?? "")}</td>
  <td>${esc(r.notes.observed ?? "")}${r.error ? `<pre>${esc(r.error.slice(0, 1500))}</pre>` : ""}</td>
  <td class="shots">${r.shots.map((s) => `<figure><a href="${s.dataUrl}" target="_blank"><img src="${s.dataUrl}" alt="${esc(s.name)}"></a><figcaption>${esc(s.name)}</figcaption></figure>`).join("")}</td>
</tr>`,
      )
      .join("\n");
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>BAP fault-suite</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#1d1f23;background:#f5f6f8}
h1{margin:0 0 4px}.summary{margin:0 0 16px;color:#555}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #e3e5e8;padding:8px;vertical-align:top;text-align:left}
th{background:#fafbfc;font-weight:600}tr.ok td:first-child{border-left:5px solid #1f9d55}tr.bad td:first-child{border-left:5px solid #c62828}
.verdict{font-size:12px;margin-top:4px}tr.ok .verdict{color:#1f9d55}tr.bad .verdict{color:#c62828}
.shots{width:34%}figure{display:inline-block;margin:0 6px 6px 0;width:31%}img{width:100%;border:1px solid #ddd}figcaption{font-size:11px;color:#666}
pre{white-space:pre-wrap;font-size:11px;color:#c62828}
</style></head><body>
<h1>Fault-suite</h1>
<p class="summary">${passed} из ${this.rows.length} кейсов прошли · ${new Date().toISOString()} · PRD §13.2</p>
<table><thead><tr><th>Кейс</th><th>Что сломали</th><th>Ожидали</th><th>Получили</th><th>Панель</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>`;
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, html);
    if (process.env.BAP_EVIDENCE) {
      mkdirSync(dirname(EVIDENCE), { recursive: true });
      copyFileSync(OUT, EVIDENCE);
    }
  }
}

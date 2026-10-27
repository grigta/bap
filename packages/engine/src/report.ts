import type { RunResult } from "./run.ts";

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const LABEL = { passed: "✓", failed: "✗", unverified: "?" } as const;

/** Self-contained HTML timeline; screenshots are referenced next to the report. */
export function renderReport(run: RunResult): string {
  const steps = run.steps
    .map(
      (s, i) => `
    <li class="${s.status}">
      <div class="head"><b>${LABEL[s.status]} ${i + 1}. ${escape(s.id)}</b>${s.mutating ? ' <span class="tag">mutating</span>' : ""}<span>${s.durationMs} мс</span></div>
      ${s.error ? `<pre class="error">${escape(s.error)}</pre>` : ""}
      ${s.screenshot ? `<img src="${escape(s.screenshot)}" alt="${escape(s.id)}" loading="lazy">` : ""}
    </li>`,
    )
    .join("");
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escape(run.scenarioId)} — ${run.status}</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; color: #111; background: #f6f7f9; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #555; margin-bottom: 16px; }
  .status { padding: 2px 10px; border-radius: 999px; font-weight: 600; }
  .status.SUCCEEDED { background: #e3f6e8; color: #116b2c; }
  .status.FAILED { background: #fde7e7; color: #a11a1a; }
  .status.NEEDS_REVIEW { background: #fff3d6; color: #8a5a00; }
  ol { list-style: none; padding: 0; display: grid; gap: 12px; }
  li { background: #fff; border: 1px solid #e3e5e8; border-left: 4px solid #2e9d4e; border-radius: 8px; padding: 12px; }
  li.failed { border-left-color: #d33; }
  li.unverified { border-left-color: #e0a100; }
  .head { display: flex; gap: 8px; align-items: center; }
  .head span:last-child { margin-left: auto; color: #666; }
  .tag { font-size: 12px; background: #eef; padding: 1px 6px; border-radius: 4px; }
  .error { white-space: pre-wrap; background: #fff5f5; color: #a11a1a; padding: 8px; border-radius: 6px; }
  img { max-width: 480px; border: 1px solid #ddd; border-radius: 6px; margin-top: 8px; display: block; }
</style>
</head>
<body>
<h1>${escape(run.scenarioId)}@${escape(run.scenarioVersion)} <span class="status ${run.status}">${run.status}</span></h1>
<div class="meta">run ${escape(run.runId)} · профиль ${escape(run.profileId)} · ${escape(run.startedAt)} → ${escape(run.finishedAt)}</div>
<ol>${steps}
</ol>
</body>
</html>
`;
}

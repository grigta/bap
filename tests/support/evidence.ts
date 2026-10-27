import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "playwright-core";

const dir = (stage: string) => {
  const d = resolve(import.meta.dirname, "../../docs/evidence", stage);
  mkdirSync(d, { recursive: true });
  return d;
};

/** Gate evidence for non-Playwright-Test suites; written only when BAP_EVIDENCE is set. */
export async function pageEvidence(page: Page, stage: string, name: string): Promise<void> {
  if (process.env.BAP_EVIDENCE) await page.screenshot({ path: `${dir(stage)}/${name}.png` });
}

export function jsonEvidence(stage: string, name: string, data: unknown): void {
  if (process.env.BAP_EVIDENCE) writeFileSync(`${dir(stage)}/${name}.json`, JSON.stringify(data, null, 2) + "\n");
}

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";

/** Saves a gate screenshot to docs/evidence/<stage>/ when run via `pnpm evidence`. */
export async function evidence(page: Page, stage: string, name: string): Promise<void> {
  if (!process.env.BAP_EVIDENCE) return;
  const dir = resolve(import.meta.dirname, "../../docs/evidence", stage);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

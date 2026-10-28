import { setTimeout as sleep } from "node:timers/promises";
import type { Page, Request } from "playwright-core";
import { type Snapshot, type SnapshotOptions, captureSnapshot } from "./snapshot.ts";

/** Requests that change what the page shows; images, media, fonts and beacons do not hold it back. */
const CONTENT = new Set(["document", "xhr", "fetch", "script", "stylesheet"]);
/** A request open this long is a background connection (long polling, streaming), not loading. */
const BACKGROUND_AFTER_MS = 5000;
/** How often the page is looked at while it settles. */
const LOOK_EVERY_MS = 250;

const trackers = new WeakMap<Page, () => number>();

/**
 * Requests of the page that are still loading content, counted from the first call for this page on.
 * Listens to the browser; nothing runs in the page.
 */
export function loadingRequests(page: Page): () => number {
  let count = trackers.get(page);
  if (!count) {
    const open = new Map<Request, number>();
    page.on("request", (r) => CONTENT.has(r.resourceType()) && open.set(r, Date.now()));
    page.on("requestfinished", (r) => open.delete(r));
    page.on("requestfailed", (r) => open.delete(r));
    count = () => [...open.values()].filter((at) => Date.now() - at < BACKGROUND_AFTER_MS).length;
    trackers.set(page, count);
  }
  return count;
}

/** What a person can do on the page right now; two equal looks in a row mean it stopped changing. */
const signature = (snap: Snapshot) =>
  `${snap.page.url}\n${snap.page.elements
    .filter((e) => e.visible && e.interactive)
    .map((e) => `${e.role}|${e.name}|${e.value ?? ""}|${e.states.join(",")}`)
    .join("\n")}`;

export interface SettleOptions extends SnapshotOptions {
  /** The run's own limit (epoch ms): past it the latest look is returned as it is. */
  deadline?: number;
  /** Stop early as soon as this holds, without waiting for the page to settle. */
  until?: (snap: Snapshot) => boolean;
}

/**
 * Waits until the page has loaded: the document is parsed, no content requests are in flight and two looks in
 * a row show the same page. There is no timeout of its own; only the run's deadline bounds it.
 * Returns the last snapshot (the caller disposes it) and whether the page settled or `until` was met.
 */
export async function settle(page: Page, opts: SettleOptions = {}): Promise<{ snap: Snapshot; settled: boolean; matched: boolean }> {
  const loading = loadingRequests(page);
  await page.waitForLoadState("domcontentloaded", { timeout: 0 }).catch(() => {});
  let previous: string | null = null;
  for (;;) {
    const snap = await captureSnapshot(page, opts);
    if (opts.until?.(snap)) return { snap, settled: false, matched: true };
    const sig = signature(snap);
    if (loading() === 0 && sig === previous) return { snap, settled: true, matched: false };
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) return { snap, settled: false, matched: false };
    previous = sig;
    await snap.dispose();
    await sleep(LOOK_EVERY_MS);
  }
}

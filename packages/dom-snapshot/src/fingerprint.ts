import type { PageSnapshot, SnapshotElement } from "./snapshot.ts";

/**
 * What a recipe remembers about its target: the features a person would use to find it again.
 * No CSS selectors and no positions in the DOM tree, which break on every redesign.
 */
export interface Fingerprint {
  role: string;
  name: string;
  tag: string;
  text: string;
  /** id, name, type, placeholder, aria-label, data-testid, href (path only), title, alt. */
  attrs: Record<string, string>;
  label: string;
  context: string;
  path: string[];
  frame: string;
  shadowHost?: string;
  interactive: boolean;
  /** Centre of the element relative to the viewport size: a weak tie-breaker only. */
  position: { x: number; y: number };
}

export interface Candidate {
  ref: string;
  score: number;
}

export type Resolution =
  | { kind: "found"; ref: string; score: number; runnerUp: Candidate | null }
  | { kind: "missing"; best: Candidate | null }
  | { kind: "ambiguous"; candidates: Candidate[] };

export interface ResolveOptions {
  /** Minimum score (0–1) for a candidate to count. */
  threshold?: number;
  /** A runner-up this close to the best makes the match ambiguous. */
  margin?: number;
}

export const DEFAULT_THRESHOLD = 0.6;
export const DEFAULT_MARGIN = 0.05;

const FP_ATTRS = ["id", "name", "type", "placeholder", "aria-label", "data-testid", "href", "title", "alt"];

const hrefPath = (href: string) => {
  try {
    return new URL(href, "http://x").pathname;
  } catch {
    return href;
  }
};

export function fingerprintOf(el: SnapshotElement, page: Pick<PageSnapshot, "viewport">): Fingerprint {
  const attrs: Record<string, string> = {};
  for (const key of FP_ATTRS) {
    const value = el.attrs[key];
    if (value) attrs[key] = key === "href" ? hrefPath(value) : value;
  }
  const w = page.viewport.width || 1;
  const h = page.viewport.height || 1;
  return {
    role: el.role,
    name: el.name,
    tag: el.tag,
    text: el.text,
    attrs,
    label: el.label,
    context: el.context,
    path: el.path,
    frame: el.frame,
    ...(el.shadowHost && { shadowHost: el.shadowHost }),
    interactive: el.interactive,
    position: { x: round((el.rect.x + el.rect.width / 2) / w), y: round((el.rect.y + el.rect.height / 2) / h) },
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Lower-case words of letters and digits; "Корзина (2)" and "корзина" share a word. */
export function words(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Two words are the same word in another form when they share a stem: a common beginning of at least 4 letters
 * covering most of the shorter word ("оформить" / "оформление"). Opposites that differ in the prefix
 * ("включить" / "выключить", "login" / "logout") share no such beginning (REQ-DOM-015).
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return common >= 4 && common >= 0.55 * Math.min(a.length, b.length);
}

/** Dice coefficient on words, where word forms of one word count as equal; 0–1. */
export function similarity(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  const x = words(a);
  const y = words(b);
  if (x.length === 0 || y.length === 0) return 0;
  const rest = [...y];
  let common = 0;
  for (const w of x) {
    const i = rest.findIndex((r) => sameWord(w, r));
    if (i >= 0) {
      common++;
      rest.splice(i, 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

const jaccard = (a: string[], b: string[]) => {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  const inter = [...sa].filter((x) => sb.has(x)).length;
  return inter / new Set([...sa, ...sb]).size;
};

/** Score of one candidate, 0–1; null when it cannot be the target at all. */
export function score(fp: Fingerprint, el: SnapshotElement, page: Pick<PageSnapshot, "viewport">): number | null {
  if (!el.visible) return null;
  if (fp.interactive && !el.interactive) return null;
  // A different accessible name with no word in common is a different element, however similar the markup.
  const nameSim = fp.name ? Math.max(similarity(fp.name, el.name), similarity(fp.name, el.text)) : null;
  if (nameSim === 0) return null;

  let total = 0;
  let got = 0;
  const add = (weight: number, value: number) => {
    total += weight;
    got += weight * value;
  };
  add(2, fp.role === el.role ? 1 : 0);
  if (nameSim !== null) add(5, nameSim);
  if (fp.text) add(1.5, similarity(fp.text, el.text));
  add(0.5, fp.tag === el.tag ? 1 : 0);
  const other = fingerprintOf(el, page);
  for (const [key, value] of Object.entries(fp.attrs)) {
    const weight = key === "data-testid" ? 2 : key === "id" || key === "name" || key === "href" ? 1.5 : key === "type" ? 1 : 0.5;
    add(weight, other.attrs[key] === value ? 1 : 0);
  }
  if (fp.label) add(1, similarity(fp.label, el.label));
  if (fp.context) add(2, similarity(fp.context, el.context));
  add(1, jaccard(fp.path, el.path));
  add(1, fp.frame === el.frame ? 1 : 0);
  if (fp.shadowHost) add(0.5, fp.shadowHost === el.shadowHost ? 1 : 0);
  const distance = Math.hypot(fp.position.x - other.position.x, fp.position.y - other.position.y);
  add(0.5, Math.max(0, 1 - distance));
  return total === 0 ? 0 : got / total;
}

/**
 * Finds the target of a fingerprint (REQ-DOM-006): the only candidate above the threshold.
 * Pure: the server runs the same check on a snapshot sent by the agent (REQ-DOM-007).
 */
export function resolve(fp: Fingerprint, page: PageSnapshot, opts: ResolveOptions = {}): Resolution {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const ranked: Candidate[] = [];
  for (const el of page.elements) {
    const s = score(fp, el, page);
    if (s !== null) ranked.push({ ref: el.ref, score: round(s) });
  }
  ranked.sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (!best || best.score < threshold) return { kind: "missing", best: best ?? null };
  if (second && second.score >= threshold && best.score - second.score < margin) {
    const close = ranked.filter((c) => c.score >= threshold && best.score - c.score < margin);
    // Several "В корзину" buttons: like a person, take the one in the card that reads like the recorded one.
    const byContext = close
      .map((c) => ({ ...c, context: similarity(fp.context, page.elements.find((e) => e.ref === c.ref)!.context) }))
      .sort((a, b) => b.context - a.context);
    if (fp.context && byContext[0]!.context - byContext[1]!.context >= CONTEXT_MARGIN)
      return { kind: "found", ref: byContext[0]!.ref, score: byContext[0]!.score, runnerUp: { ref: byContext[1]!.ref, score: byContext[1]!.score } };
    return { kind: "ambiguous", candidates: close };
  }
  return { kind: "found", ref: best.ref, score: best.score, runnerUp: second ?? null };
}

/** How much better the container text of one of several close candidates must match to decide between them. */
const CONTEXT_MARGIN = 0.2;

const TEXT_FIELDS = ["name", "text", "label", "context"] as const;

/** Input values in the target's texts become {{input.key}}, so the recipe works for other inputs. */
export function templatize(fp: Fingerprint, input: Record<string, unknown>): Fingerprint {
  const values = Object.entries(input)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  const sub = (s: string) => values.reduce((acc, [key, value]) => acc.split(value).join(`{{input.${key}}}`), s);
  const out: Fingerprint = { ...fp, attrs: Object.fromEntries(Object.entries(fp.attrs).map(([k, v]) => [k, sub(v)])) };
  for (const f of TEXT_FIELDS) out[f] = sub(fp[f]);
  return out;
}

/** Fills {{input.key}} placeholders with this run's input. */
export function renderTemplate(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{\{\s*input\.([\w-]+)\s*\}\}/g, (_m, key: string) => {
    const value = input[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function renderFingerprint(fp: Fingerprint, input: Record<string, unknown>): Fingerprint {
  const out: Fingerprint = { ...fp, attrs: Object.fromEntries(Object.entries(fp.attrs).map(([k, v]) => [k, renderTemplate(v, input)])) };
  for (const f of TEXT_FIELDS) out[f] = renderTemplate(fp[f], input);
  return out;
}

/**
 * Whether the page shows this text anywhere (all frames), ignoring case and spacing. Accessible names of visible
 * elements count too: they are what the snapshot shows (a cart button named "Cart, 1 items" has no such text).
 */
export function pageHasText(page: PageSnapshot, text: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = norm(text);
  return norm(page.text).includes(wanted) || page.elements.some((e) => e.visible && norm(e.name).includes(wanted));
}

import { setTimeout as sleep } from "node:timers/promises";
import { type PageSnapshot, type Snapshot, type SnapshotElement, act, settle } from "@bap/dom-snapshot";
import { type Step, type StepContext, defineScenario } from "@bap/scenario-sdk";
import type { Page } from "playwright-core";
import { z } from "zod";
import { navigation } from "./record.ts";

/** One warm-up session (PRD §17): a search, then a few sites from the results, each read by scrolling. */
export const farmInputSchema = z.object({
  query: z.string().min(1),
  sites: z.number().int().min(1).max(10),
  dwellSeconds: z.number().int().min(1).max(600),
  searchUrl: z.url(),
});
export type FarmInput = z.infer<typeof farmInputSchema>;

interface FarmState {
  /** The results page, to come back to (also after a resume). */
  resultsUrl: string | null;
  /** Hosts already read in this session. */
  visited: string[];
}

export class FarmError extends Error {
  readonly errorCode: string;
  constructor(code: "FARM_CAPTCHA" | "FARM_NO_SEARCH_FIELD" | "FARM_TOO_FEW_SITES", message: string) {
    super(message);
    this.errorCode = code;
  }
}

/**
 * Accepting a search engine's cookies. Google's own dialog keeps the same id in every language; its separate consent
 * page is matched by the button's words, in the languages a profile's proxy may bring.
 */
const CONSENT_ID = "L2AGLb";
const CONSENT =
  /^(accept all|i agree|принять все|прийняти все|alle akzeptieren|tout accepter|aceptar todo|accetta tutto|aceitar tudo|zaakceptuj wszystko|alles accepteren|hyväksy kaikki|godkänn alla|acceptér alle|accepter alle|godta alle|samþykkja allt|přijmout vše|prijať všetko|az összes elfogadása|acceptă tot|приемане на всички|прихвати све|prihvati sve|sprejmi vse|nõustu kõigiga|pieņemt visu|sutikti su viskuo|αποδοχή όλων|tümünü kabul et|קבל הכל|قبول الكل|すべて同意する|모두 수락|全部接受|接受全部)$/i;
const isConsent = (e: SnapshotElement) => e.visible && e.interactive && (e.attrs.id === CONSENT_ID || ((e.role === "button" || e.role === "link") && CONSENT.test(e.name)));

/** Sites of the search engine itself: never part of the warm-up. */
const OWN = /(^|\.)(google\.[a-z.]+|googleadservices\.com|googleusercontent\.com|gstatic\.com|youtube\.com|doubleclick\.net)$/;
const AD_LABEL = /(^|\s)(реклама|sponsored|спонсируется|anzeige|annonce|publicidad)(\s|·|$)/i;

const random = (min: number, max: number, rnd: () => number) => min + Math.floor(rnd() * (max - min + 1));

/** A host without "www.": the same site whichever way a link or the browser spells it. */
export const siteOf = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** The address a result shows to the reader ("Forbes https://www.forbes.com › advisor"). */
const SHOWN_URL = /\bhttps?:\/\/([a-z0-9.-]+(?::\d+)?)/i;

/**
 * Where a result leads. A direct link names its site; a link through the search engine's own redirect (Google's
 * `/goto?url=…`, `/url?q=…`) hides it, so the site is taken from the redirect's parameter or from the address the
 * result shows. Links to the search engine itself lead nowhere new.
 */
function destination(e: SnapshotElement, pageUrl: string, searchHost: string): string | null {
  let url: URL;
  try {
    url = new URL(e.attrs.href!, pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  if (url.host !== searchHost && !OWN.test(url.hostname)) return url.host;
  if (url.host !== searchHost && !/(^|\.)google\.[a-z.]+$/.test(url.hostname)) return null;
  if (!/^\/(goto|url)$/.test(url.pathname)) return null;
  const param = url.searchParams.get("q") ?? url.searchParams.get("url") ?? "";
  if (/^https?:\/\//.test(param)) return hostOf(param) || null;
  return SHOWN_URL.exec(`${e.name} ${e.text}`)?.[1] ?? null;
}

/**
 * Organic results that lead to other sites, one link per site, in random order. Ads (by their address or the
 * label next to them), the search engine's own sites and sites in `skip` are left out.
 */
export function pickResults(page: PageSnapshot, searchHost: string, skip: string[], rnd: () => number): { ref: string; host: string }[] {
  const seen = new Set(skip.map(siteOf));
  const picked: { ref: string; host: string }[] = [];
  for (const e of page.elements) {
    if (!isResult(e)) continue;
    const host = destination(e, page.url, searchHost);
    if (!host || OWN.test(host.split(":")[0]!) || seen.has(siteOf(host))) continue;
    seen.add(siteOf(host));
    picked.push({ ref: e.ref, host });
  }
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [picked[i], picked[j]] = [picked[j]!, picked[i]!];
  }
  return picked;
}

const isResult = (e: SnapshotElement) =>
  e.role === "link" && e.visible && e.interactive && !!e.attrs.href && e.name.length > 0 && !("data-rw" in e.attrs) && !("data-pcu" in e.attrs) && !AD_LABEL.test(e.context);

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

type Ctx = StepContext<FarmInput, FarmState>;

const look = (ctx: Ctx, until?: (s: Snapshot) => boolean) => settle(ctx.page, { deadline: ctx.deadline, until });

async function failIfCaptcha(snap: Snapshot) {
  if (/\/sorry\/|recaptcha/.test(snap.page.url) || snap.page.elements.some((e) => /recaptcha/.test(e.frame)))
    throw new FarmError("FARM_CAPTCHA", `the search engine asks for a captcha at ${snap.page.url}`);
}

/** Scrolls the page with the wheel for `seconds`, the way a person reads: uneven turns, pauses, sometimes back up. */
export async function dwell(page: Page, seconds: number, deadline: number | undefined, rnd: () => number = Math.random): Promise<number> {
  const end = Math.min(Date.now() + seconds * 1000, deadline ?? Infinity);
  const session = await page.context().newCDPSession(page);
  let turns = 0;
  try {
    const metrics = async () => (await session.send("Page.getLayoutMetrics")) as { cssVisualViewport: { pageY: number; clientWidth: number; clientHeight: number }; cssContentSize: { height: number } };
    while (Date.now() < end) {
      const m = await metrics();
      const { pageY, clientWidth, clientHeight } = m.cssVisualViewport;
      const atBottom = pageY + clientHeight >= m.cssContentSize.height - 10;
      const down = !atBottom && (pageY === 0 || rnd() < 0.85);
      await page.mouse.move(random(Math.round(clientWidth * 0.3), Math.round(clientWidth * 0.7), rnd), random(Math.round(clientHeight * 0.3), Math.round(clientHeight * 0.7), rnd), { steps: random(3, 8, rnd) });
      if (down || pageY > 0) {
        await page.mouse.wheel(0, (down ? 1 : -1) * random(120, 480, rnd));
        turns++;
      }
      await sleep(Math.max(0, Math.min(random(700, 2600, rnd), end - Date.now())));
    }
  } finally {
    await session.detach().catch(() => {});
  }
  return turns;
}

/**
 * The page with the cookie consent accepted, if the search engine asked for it (in the first look or later, over
 * the search field). A captcha ends the session.
 */
async function accepted(ctx: Ctx, snap: Snapshot): Promise<Snapshot> {
  try {
    await failIfCaptcha(snap);
  } catch (e) {
    await snap.dispose();
    throw e;
  }
  const consent = snap.page.elements.find(isConsent);
  if (!consent) return snap;
  try {
    await act(ctx.page, snap.handles.get(consent.ref)!, { kind: "click" });
  } finally {
    await snap.dispose();
  }
  ctx.annotate?.({ note: `согласие на cookie: «${consent.name}»` });
  const after = (await look(ctx, (s) => !s.page.elements.some(isConsent))).snap;
  try {
    await failIfCaptcha(after);
  } catch (e) {
    await after.dispose();
    throw e;
  }
  return after;
}

/** Back to the results: through history like a person, or by address after a resume. */
async function backToResults(ctx: Ctx) {
  const results = ctx.state.resultsUrl!;
  if (ctx.page.url() === results) return;
  const back = await ctx.page.goBack(navigation(ctx.deadline)).catch(() => null);
  if (!back || ctx.page.url() !== results) await ctx.page.goto(results, navigation(ctx.deadline));
}

/** A warm-up session as a scenario: the engine runs it like any other (screenshots, cancel, deadline). */
export function farmScenario(input: FarmInput, rnd: () => number = Math.random) {
  const params = farmInputSchema.parse(input);
  const steps: Step<FarmInput, FarmState>[] = [
    {
      id: "s01",
      intent: "Открыть поиск",
      async run(ctx) {
        await ctx.page.goto(ctx.input.searchUrl, navigation(ctx.deadline));
        const { snap } = await look(ctx);
        await (await accepted(ctx, snap)).dispose();
      },
    },
    {
      id: "s02",
      intent: "Ввести запрос",
      async run(ctx) {
        const field = (s: Snapshot) =>
          s.page.elements.find((e) => e.visible && e.interactive && (e.tag === "textarea" || e.tag === "input") && e.attrs.name === "q") ??
          s.page.elements.find((e) => e.visible && e.interactive && (e.role === "searchbox" || e.role === "combobox"));
        const snap = await accepted(ctx, (await look(ctx, (s) => field(s) !== undefined)).snap);
        try {
          const target = field(snap);
          if (!target) throw new FarmError("FARM_NO_SEARCH_FIELD", `no search field on ${snap.page.url}`);
          await act(ctx.page, snap.handles.get(target.ref)!, { kind: "click" });
        } finally {
          await snap.dispose();
        }
        // Typed key by key with a person's uneven rhythm.
        for (const ch of ctx.input.query) {
          await ctx.page.keyboard.type(ch);
          await sleep(random(60, 220, rnd));
        }
        await sleep(random(300, 900, rnd));
        const before = ctx.page.url();
        await ctx.page.keyboard.press("Enter");
        const { snap: results } = await look(ctx, (s) => s.page.url !== before && pickResults(s.page, new URL(ctx.input.searchUrl).host, [], () => 0).length > 0);
        try {
          await failIfCaptcha(results);
          ctx.state.resultsUrl = results.page.url;
          ctx.annotate?.({ note: `запрос «${ctx.input.query}»` });
        } finally {
          await results.dispose();
        }
      },
    },
    ...Array.from({ length: params.sites }, (_, i): Step<FarmInput, FarmState> => ({
      id: `s${String(i + 3).padStart(2, "0")}`,
      intent: `Сайт ${i + 1} из выдачи`,
      async run(ctx) {
        const searchHost = new URL(ctx.input.searchUrl).host;
        // Each result is tried at most once: one that does not open is skipped for the next.
        const tried = [...ctx.state.visited];
        for (;;) {
          await backToResults(ctx);
          const { snap } = await look(ctx, (s) => pickResults(s.page, searchHost, tried, () => 0).length > 0);
          const next = pickResults(snap.page, searchHost, tried, rnd)[0];
          if (!next) {
            await snap.dispose();
            throw new FarmError("FARM_TOO_FEW_SITES", `the results gave ${ctx.state.visited.length} of ${ctx.input.sites} sites (${ctx.state.resultsUrl})`);
          }
          tried.push(next.host);
          try {
            await act(ctx.page, snap.handles.get(next.ref)!, { kind: "click" });
          } finally {
            await snap.dispose();
          }
          // Opened as soon as the browser is on another site (the search engine's redirect is passed through): busy
          // pages (carousels, ads) never look the same twice. Wherever the result led counts, the site is noted as it is.
          const elsewhere = (url: string) => {
            const host = hostOf(url);
            return /^https?:/.test(url) && host !== "" && host !== searchHost && !OWN.test(host.split(":")[0]!) && !ctx.state.visited.map(siteOf).includes(siteOf(host));
          };
          const { snap: site } = await look(ctx, (s) => elsewhere(s.page.url));
          const opened = site.page.url;
          await site.dispose();
          if (!elsewhere(opened)) continue; // did not open (error page, new tab, back on the results): the next result
          const host = hostOf(opened);
          const started = Date.now();
          const turns = await dwell(ctx.page, ctx.input.dwellSeconds, ctx.deadline, rnd);
          ctx.state.visited.push(host);
          ctx.annotate?.({ note: `${host}: ${Math.round((Date.now() - started) / 1000)} с, прокруток ${turns}` });
          return;
        }
      },
    })),
  ];
  return defineScenario({
    id: "farm",
    version: "1.0.0",
    inputSchema: farmInputSchema,
    // Nothing here changes a site: after a crash the session continues where it stopped.
    autoResume: true,
    initialState: () => ({ resultsUrl: null, visited: [] }),
    steps,
  });
}

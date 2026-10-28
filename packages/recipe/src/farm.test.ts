import type { PageSnapshot, SnapshotElement } from "@bap/dom-snapshot";
import { describe, expect, test } from "vitest";
import { farmScenario, pickResults } from "./farm.ts";

let refs = 0;
const link = (href: string, name: string, extra: Partial<SnapshotElement> = {}): SnapshotElement => ({
  ref: `e${++refs}`,
  role: "link",
  name,
  tag: "a",
  text: name,
  attrs: { href },
  states: [],
  visible: true,
  interactive: true,
  rect: { x: 0, y: 0, width: 100, height: 20 },
  label: "",
  context: name,
  path: [],
  frame: "",
  ...extra,
});
const serp = (elements: SnapshotElement[]): PageSnapshot => ({ url: "https://www.google.com/search?q=accounting+software", title: "", canScrollDown: true, viewport: { width: 1200, height: 800 }, elements, text: "" });
const hosts = (page: PageSnapshot, skip: string[] = [], rnd = () => 0.5) => pickResults(page, "www.google.com", skip, rnd).map((r) => r.host).sort();

describe("warm-up: which results are opened", () => {
  test("[REQ-FARM-001] organic results of other sites, one link per host; ads and the search engine's own sites are left out", () => {
    const page = serp([
      link("https://www.quickbooks.com/", "QuickBooks Online Accounting Software"),
      link("https://www.quickbooks.com/pricing", "Pricing"),
      link("https://www.xero.com/", "Xero Accounting"),
      link("/search?q=accounting+software&tbm=isch", "Картинки"),
      link("https://translate.google.com/translate?u=x", "Перевести эту страницу"),
      link("https://www.youtube.com/watch?v=1", "Accounting tutorial"),
      link("https://www.googleadservices.com/pagead/aclk?sa=L", "Учёт за 5 минут"),
      link("https://ads.example.com/", "Бухгалтерия онлайн", { attrs: { href: "https://ads.example.com/", "data-rw": "1" } }),
      link("https://sponsor.example.com/", "Freshbooks", { context: "Sponsored Freshbooks" }),
      link("https://реклама.example/", "Учёт", { context: "Реклама · Учёт для ИП" }),
      link("https://www.zoho.com/books/", "Zoho Books", { visible: false }),
      link("mailto:x@example.com", "Написать"),
      link("https://www.sage.com/", "Sage"),
    ]);
    expect(hosts(page)).toEqual(["www.quickbooks.com", "www.sage.com", "www.xero.com"]);
  });

  test("[REQ-FARM-001] a result behind the search engine's redirect leads where its shown address says; one without an address is left out", () => {
    const page = serp([
      link("/goto?url=CAESggEB6zswFZu08ky", "10 Best Accounting Software Forbes https://www.forbes.com › advisor"),
      link("/goto?url=CAESggEB6zswFXb0", "Read more"),
      link("/url?q=https://www.manager.io/&sa=U", "Manager.io"),
      link("/goto?url=CAESggEB6zswFZu09", "Forbes again https://forbes.com"),
      link("/goto?url=CAESZAHrOzAVkBnq", "Accounting Operations Software https://www.floqast.com", { attrs: { href: "/goto?url=CAESZAHrOzAVkBnq", "data-rw": "https://www.google.com/aclk?sa=L" } }),
      link("/goto?url=CAESZgHrOzAV3qvf", "Best accounting software https://www.youtube.com › watch"),
    ]);
    expect(hosts(page)).toEqual(["www.forbes.com", "www.manager.io"]);
  });

  test("[REQ-FARM-001] hosts already read are not opened again; the order is random", () => {
    const page = serp(["a", "b", "c", "d"].map((h) => link(`https://${h}.example.com/`, h)));
    expect(hosts(page, ["a.example.com", "c.example.com"])).toEqual(["b.example.com", "d.example.com"]);
    const first = (rnd: () => number) => pickResults(page, "www.google.com", [], rnd)[0]!.host;
    expect(new Set([0, 0.3, 0.6, 0.99].map((v) => first(() => v))).size).toBeGreaterThan(1);
  });

  test("[REQ-FARM-001] a session is a search and then one step per site, none of them changes a site", () => {
    const s = farmScenario({ query: "accounting software", sites: 3, dwellSeconds: 40, searchUrl: "https://www.google.com/" });
    expect(s.steps.map((x) => x.intent)).toEqual(["Открыть поиск", "Ввести запрос", "Сайт 1 из выдачи", "Сайт 2 из выдачи", "Сайт 3 из выдачи"]);
    expect(s.steps.every((x) => !x.mutating)).toBe(true);
    expect(() => farmScenario({ query: "", sites: 3, dwellSeconds: 40, searchUrl: "https://www.google.com/" })).toThrow();
  });
});

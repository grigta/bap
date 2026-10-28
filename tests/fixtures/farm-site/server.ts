// A stand-in search engine for warm-up sessions (S14): a search page, results with ads, five organic sites on
// their own ports, a consent page and a captcha page. It records which pages were opened, from where, and how
// each site was read (scroll events and time on the page, reported by the page itself when it is left).
import { type IncomingMessage, type ServerResponse, type Server, createServer } from "node:http";

const port = Number(process.env.PORT ?? 4330);
const hits: { server: string; path: string; referer: string | null; at: number }[] = [];
const reads: { site: string; scrolls: number; maxY: number; ms: number }[] = [];

const page = (title: string, body: string) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:24px;max-width:760px}</style></head><body>${body}</body></html>`;
const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
  res.end(html);
};
const record = (server: string, req: IncomingMessage) => req.url === "/favicon.ico" || hits.push({ server, path: req.url ?? "/", referer: req.headers.referer ?? null, at: Date.now() });

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void, on = 0): Promise<{ server: Server; url: string }> {
  return new Promise((ready) => {
    const server = createServer(handler).listen(on, "127.0.0.1", () => ready({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
  });
}

const search = `http://127.0.0.1:${port}`;
const PARAGRAPH = "Бухгалтерский учёт малого бизнеса: первичные документы, счета, акты и отчётность. ".repeat(6);

const sites = await Promise.all(
  [1, 2, 3, 4, 5].map((n) =>
    listen((req, res) => {
      record(`site${n}`, req);
      // The page reports how it was read when it is left; a beacon needs no answer and no CORS.
      send(
        res,
        200,
        page(
          `Сайт ${n}`,
          `<h1>Сайт ${n}</h1>${`<p>${PARAGRAPH}</p>`.repeat(40)}
<script>
  let scrolls = 0, maxY = 0; const started = performance.now();
  addEventListener("scroll", () => { scrolls++; maxY = Math.max(maxY, scrollY); });
  addEventListener("pagehide", () => navigator.sendBeacon(${JSON.stringify(`${search}/beacon`)}, JSON.stringify({ site: "site${n}", scrolls, maxY, ms: Math.round(performance.now() - started) })));
</script>`,
        ),
      );
    }),
  ),
);
const ads = await listen((req, res) => {
  record("ad", req);
  send(res, 200, page("Реклама", "<h1>Рекламная страница</h1>"));
});

const searchPage = page(
  "Поиск",
  `<form action="/search"><input type="search" name="q" aria-label="Поиск" autocomplete="off"> <button>Найти</button></form>`,
);

const results = (q: string) => {
  const organic = q === "мало сайтов" ? sites.slice(0, 1) : sites;
  return page(
    `${q} — Поиск`,
    `<form action="/search"><input type="search" name="q" aria-label="Поиск" value="${q.replace(/"/g, "&quot;")}"> <button>Найти</button></form>
<div id="tads"><span>Реклама</span>
  <div><a href="${ads.url}/landing" data-rw="1" data-pcu="${ads.url}"><h3>Бухгалтерия онлайн — скидка 50%</h3></a></div>
  <div><a href="https://www.googleadservices.com/pagead/aclk?sa=L&ai=x"><h3>Учёт за 5 минут</h3></a></div>
</div>
<div id="rso">
${organic
  .map(
    // The first results link straight to the site; the rest go through the search engine's own redirect, like Google
    // does now, and show the site's address inside the link.
    (s, i) => `<div>${i < 2 ? `<a href="${s.url}/article"><h3>Сайт ${i + 1}: ${q}</h3></a><cite>${s.url}</cite>` : `<a href="/goto?url=r${i}"><h3>Сайт ${i + 1}: ${q}</h3><cite>${s.url}</cite></a>`}
  <a href="https://translate.google.com/translate?u=${encodeURIComponent(s.url)}">Перевести эту страницу</a>${i === 0 ? `<a href="${s.url}/more"><h3>Ещё с сайта 1</h3></a>` : ""}</div>`,
  )
  .join("\n")}
</div>`,
  );
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", search);
  if (url.pathname === "/log") {
    if (req.method === "DELETE") {
      hits.length = 0;
      reads.length = 0;
      res.writeHead(204).end();
    } else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hits, reads, sites: sites.map((s) => s.url), ad: ads.url }));
    return;
  }
  if (url.pathname === "/beacon") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      reads.push(JSON.parse(body));
      res.writeHead(204).end();
    });
    return;
  }
  record("search", req);
  if (url.pathname === "/") return send(res, 200, searchPage);
  // Google's own dialog: it covers the search field, and its buttons keep their ids in every language.
  if (url.pathname === "/fi")
    return send(
      res,
      200,
      searchPage.replace(
        "</body>",
        `<div id="consent" role="dialog" aria-label="Ennen kuin jatkat Googleen" style="position:fixed;inset:0;background:#fffe;padding:40px"><h2>Ennen kuin jatkat Googleen</h2><p>Käytämme evästeitä ja dataa.</p>
<button id="W0wltc" onclick="document.getElementById('consent').remove()">Hylkää kaikki</button> <button id="L2AGLb" onclick="document.getElementById('consent').remove()">Hyväksy kaikki</button></div></body>`,
      ),
    );
  if (url.pathname === "/goto") return send(res, 302, "", { location: `${sites[Number(url.searchParams.get("url")?.slice(1))]!.url}/article` });
  if (url.pathname === "/search") return send(res, 200, results(url.searchParams.get("q") ?? ""));
  if (req.method === "GET" && url.pathname === "/consent")
    return send(res, 200, page("Прежде чем перейти к поиску", `<h1>Прежде чем перейти к поиску</h1><p>Мы используем файлы cookie.</p><form method="post" action="/consent"><button name="a" value="0">Отклонить все</button> <button name="a" value="1">Принять все</button></form>`));
  if (url.pathname === "/sorry/") return send(res, 429, page("Sorry", "<h1>Our systems have detected unusual traffic from your computer network.</h1>"));
  if (req.method === "POST" && url.pathname === "/consent") return send(res, 303, "", { location: "/", "set-cookie": "consent=yes; Path=/" });
  send(res, 404, page("Нет", "<h1>Нет такой страницы</h1>"));
}).listen(port, "127.0.0.1", () => console.log(`farm-site on ${search}`));

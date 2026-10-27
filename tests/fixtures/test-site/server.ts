// Test site for e2e tests: visit counter, 5-step order wizard, order list, slow and failing pages.
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";

const index = readFileSync(new URL("./index.html", import.meta.url));
const port = Number(process.env.PORT ?? 4310);
const orders: { id: number; item: string; createdAt: string }[] = [];

const page = (title: string, body: string) => `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.4 system-ui,sans-serif;margin:40px;color:#111}label,button{display:block;margin:8px 0}</style>
</head><body><h1>${title}</h1>${body}</body></html>`;

const send = (res: ServerResponse, status: number, html: string) =>
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(html);

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function wizardStep(step: number, item: string): string {
  const hidden = `<input type="hidden" name="item" value="${escape(item)}">`;
  if (step === 1)
    return page("Шаг 1 из 5: товар", `<form action="/wizard"><input type="hidden" name="step" value="2"><label>Товар <input name="item" required></label><button>Далее</button></form>`);
  if (step === 2 || step === 3)
    return page(`Шаг ${step} из 5: проверка`, `<p>Товар: <b id="item">${escape(item)}</b></p><form action="/wizard"><input type="hidden" name="step" value="${step + 1}">${hidden}<button>Далее</button></form>`);
  return page("Шаг 4 из 5: оформление", `<p>Товар: <b id="item">${escape(item)}</b></p><form method="post" action="/wizard/order">${hidden}<button>Оформить заказ</button></form>`);
}

async function readForm(req: AsyncIterable<Buffer>): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /" || route === "GET /index.html") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(index);

  if (route === "GET /wizard") {
    const step = Number(url.searchParams.get("step") ?? 1);
    return send(res, 200, wizardStep(Math.min(Math.max(step, 1), 4), url.searchParams.get("item") ?? ""));
  }
  if (route === "POST /wizard/order") {
    const item = (await readForm(req)).get("item") ?? "";
    const order = { id: orders.length + 1, item, createdAt: new Date().toISOString() };
    orders.push(order);
    return send(res, 201, page("Шаг 5 из 5: готово", `<p>Заказ <b id="order-id">#${order.id}</b> оформлен.</p><a href="/orders">Все заказы</a>`));
  }
  if (route === "GET /orders") {
    const rows = orders.map((o) => `<tr><td>#${o.id}</td><td>${escape(o.item)}</td></tr>`).join("");
    return send(res, 200, page("Заказы", `<p>Всего: <b id="orders-count">${orders.length}</b></p><table>${rows}</table>`));
  }
  if (route === "GET /api/orders") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(orders));
  if (route === "DELETE /api/orders") {
    orders.length = 0;
    return res.writeHead(204).end();
  }

  if (route === "GET /slow") {
    const ms = Number(url.searchParams.get("ms") ?? 3000);
    await new Promise((r) => setTimeout(r, ms));
    return send(res, 200, page("Медленная страница", `<p id="slow">Ответ через ${ms} мс</p>`));
  }
  if (route === "GET /crash") return send(res, 500, page("Ошибка 500", "<p>Стенд намеренно упал.</p>"));

  send(res, 404, page("404", "<p>Нет такой страницы.</p>"));
}).listen(port, "127.0.0.1", () => console.log(`test-site on http://127.0.0.1:${port}`));

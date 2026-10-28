// "Shapeshifter" shop for S11: the same order flow, but markup, classes, ids, nesting, order and
// wrappers change with the layout seed. Wording 1 renames buttons and fields: a redesign that needs healing.
// Flow: catalog → "В корзину" (mutating) → cart → checkout (fields, promo in shadow DOM,
// consent in a cross-origin iframe, pickup in a same-origin iframe) → "Оформить заказ" (mutating) → order page.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const port = Number(process.env.PORT ?? 4320);
let layout = { seed: Number(process.env.SEED ?? 1), wording: 0 };

const PRODUCTS = [
  { id: "p1", title: "Ноутбук Pro 15", price: 1999 },
  { id: "p2", title: "Мышь беспроводная", price: 29 },
  { id: "p3", title: "Монитор 27 дюймов", price: 349 },
  { id: "p4", title: "Клавиатура механическая", price: 89 },
];
interface Session { cart: string[]; consent: boolean }
const sessions = new Map<string, Session>();
const orders: { id: number; sid: string; items: string[]; name: string; phone: string; address: string; delivery: string; promo: string; comment: string }[] = [];

const WORDS = [
  { search: "Поиск товаров", find: "Найти", add: "В корзину", cart: "Корзина", toCheckout: "Перейти к оформлению", name: "Имя", phone: "Телефон", address: "Адрес", comment: "Комментарий", delivery: "Способ доставки", place: "Оформить заказ", consent: "Я согласен с условиями", done: "оформлен" },
  { search: "Что ищем?", find: "Искать", add: "Купить", cart: "Мои покупки", toCheckout: "К оплате", name: "Как вас зовут", phone: "Номер для связи", address: "Куда доставить", comment: "Пожелания", delivery: "Доставка", place: "Подтвердить покупку", consent: "Принимаю условия", done: "оформлен" },
];

/** Seeded PRNG (mulberry32): the same seed always gives the same page. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Markup helpers bound to one page render: every page derives its own stream from the seed. */
function shaper(page: string) {
  const r = rng(layout.seed * 7919 + [...page].reduce((h, c) => h * 31 + c.charCodeAt(0), 0));
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const cls = () => `${pick(["x", "c", "u", "k"])}${Math.floor(r() * 1e6).toString(36)}`;
  const shuffle = <T,>(xs: T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  /** 0–3 meaningless wrappers around the content. */
  const wrap = (html: string) => {
    let out = html;
    for (let i = Math.floor(r() * 4); i > 0; i--) {
      const tag = pick(["div", "div", "span", "section"]);
      out = `<${tag} class="${cls()}">${out}</${tag}>`;
    }
    return out;
  };
  const id = (base: string) => (r() < 0.5 ? `${base}-${Math.floor(r() * 1e4)}` : `${cls()}`);
  /** A text field labelled in one of the usual ways; the accessible name stays the same. */
  const field = (label: string, name: string, type = "text", required = true) => {
    const fid = id(name);
    const req = required ? " required" : "";
    switch (Math.floor(r() * 4)) {
      case 0:
        return wrap(`<label for="${fid}" class="${cls()}">${label}</label>${wrap(`<input id="${fid}" name="${name}" type="${type}" class="${cls()}"${req}>`)}`);
      case 1:
        return wrap(`<label class="${cls()}"><span>${label}</span> <input name="${name}" type="${type}" class="${cls()}"${req}></label>`);
      case 2:
        return wrap(`<input name="${name}" type="${type}" aria-label="${label}" placeholder="${label}" class="${cls()}"${req}>`);
      default: {
        const lid = id("lbl");
        return wrap(`<div id="${lid}" class="${cls()}">${label}</div>${wrap(`<input name="${name}" type="${type}" aria-labelledby="${lid}" class="${cls()}"${req}>`)}`);
      }
    }
  };
  /** A submit control: <button>, <input type=submit> or a scripted role=button. */
  const submit = (label: string) =>
    wrap(
      pick([
        `<button type="submit" class="${cls()}">${label}</button>`,
        `<input type="submit" value="${label}" class="${cls()}">`,
        `<div role="button" tabindex="0" class="${cls()} btn" onclick="this.closest('form').requestSubmit()" onkeydown="if(event.key==='Enter')this.closest('form').requestSubmit()">${label}</div>`,
      ]),
    );
  const decoy = () => wrap(pick([`<button type="button" class="${cls()}">Сравнить</button>`, `<button type="button" class="${cls()}">В избранное</button>`, `<a href="#" class="${cls()}">Подробнее</a>`, ""]));
  return { r, pick, cls, shuffle, wrap, id, field, submit, decoy };
}

const W = () => WORDS[layout.wording] ?? WORDS[0]!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

function doc(title: string, body: string, s: ReturnType<typeof shaper>) {
  const nav = s.shuffle([`<a href="/">Каталог</a>`, `<a href="/cart">${W().cart}</a>`, `<a href="/help">Помощь</a>`]).join(" ");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font:16px/1.4 system-ui,sans-serif;margin:0;color:#111}
header,main{padding:16px 32px}header{background:#f2f2f2;display:flex;gap:16px}
.btn{display:inline-block;padding:4px 10px;border:1px solid #888;border-radius:4px;cursor:pointer;background:#eee}
input,select,button{font:inherit;margin:4px 0}label{display:block}
.card{border:1px solid #ddd;padding:8px;margin:8px 0;border-radius:6px}
iframe{border:1px solid #ccc;width:420px;height:70px;display:block;margin:8px 0}
</style></head><body>${s.wrap(`<header class="${s.cls()}">${nav}</header>`)}<main class="${s.cls()}">${s.wrap(`<h1>${title}</h1>`)}${body}</main></body></html>`;
}

function catalog(query: string) {
  const s = shaper("catalog");
  const w = W();
  const found = PRODUCTS.filter((p) => p.title.toLowerCase().includes(query.toLowerCase()));
  const search = `<form action="/" role="search" class="${s.cls()}">${s.field(w.search, "q", "search", false)}${s.submit(w.find)}</form>`;
  const cards = s.shuffle(found).map((p) => {
    const parts = s.shuffle([`<h2 class="${s.cls()}">${p.title}</h2>`, `<p class="${s.cls()}">${p.price} ₽</p>`]);
    const buy = `<form method="post" action="/cart/add" class="${s.cls()}"><input type="hidden" name="product" value="${p.id}">${s.submit(w.add)}</form>`;
    return s.wrap(`<article class="card ${s.cls()}">${parts.join("")}${s.shuffle([buy, s.decoy()]).join("")}</article>`);
  });
  return doc("Каталог", `${s.wrap(search)}${cards.join("") || "<p>Ничего не найдено</p>"}`, s);
}

function cart(session: Session) {
  const s = shaper("cart");
  const w = W();
  const rows = session.cart.map((id) => PRODUCTS.find((p) => p.id === id)!).map((p) => s.wrap(`<li class="${s.cls()}">${p.title} — ${p.price} ₽</li>`));
  const body = rows.length ? `<ul>${rows.join("")}</ul>${s.wrap(`<a href="/checkout" class="btn ${s.cls()}">${w.toCheckout}</a>`)}` : "<p>Корзина пуста</p>";
  return doc(w.cart, body, s);
}

/** The consent widget lives on the other host name, so it is a cross-origin (out-of-process) frame. */
const otherHost = (host: string) => (host.startsWith("127.0.0.1") ? host.replace("127.0.0.1", "localhost") : host.replace("localhost", "127.0.0.1"));

function checkout(sid: string, host: string) {
  const s = shaper("checkout");
  const w = W();
  const fields = s.shuffle([
    s.field(w.name, "name"),
    s.field(w.phone, "phone", "tel"),
    s.field(w.address, "address"),
    s.field(w.comment, "comment", "text", false),
    s.wrap(`<label class="${s.cls()}">${w.delivery} <select name="delivery" class="${s.cls()}"><option value="">—</option>${s.shuffle(["Курьер", "Самовывоз", "Почта"]).map((d) => `<option>${d}</option>`).join("")}</select></label>`),
  ]);
  const promo = `<promo-code class="${s.cls()}"></promo-code>`;
  const consent = `<iframe title="Условия" src="http://${otherHost(host)}/consent-frame?sid=${sid}"></iframe>`;
  const pickup = `<iframe title="Пункт выдачи" src="/pickup-frame"></iframe>`;
  const form = `<form method="post" action="/order" class="${s.cls()}">${fields.join("")}${s.wrap(promo)}<input type="hidden" name="promo"></form>`;
  // The promo field sits in a shadow root (open or closed by seed) and copies its value into the form.
  const mode = s.r() < 0.5 ? "open" : "closed";
  const script = `<script>
customElements.define("promo-code", class extends HTMLElement {
  constructor() { super(); const root = this.attachShadow({ mode: "${mode}" });
    root.innerHTML = '<label>Промокод <input name="code"></label> <button type="button">Применить</button> <span></span>';
    root.querySelector("button").onclick = () => { this.closest("form").promo.value = root.querySelector("input").value; root.querySelector("span").textContent = "Промокод применён"; };
  }
});
</script>`;
  // Submit sits outside the form markup order but submits it via form=.
  const formId = s.id("order");
  const formWithId = form.replace('<form method="post"', `<form id="${formId}" method="post"`);
  const submit = s.submit(w.place).replace(/onclick="[^"]*"/, `onclick="document.getElementById('${formId}').requestSubmit()"`).replace(/onkeydown="[^"]*"/, "").replace('type="submit"', `type="submit" form="${formId}"`);
  return doc("Оформление", `${script}${s.shuffle([formWithId, s.wrap(consent), s.wrap(pickup)]).join("")}${s.wrap(submit)}`, s);
}

function consentFrame(sid: string) {
  const s = shaper("consent");
  const w = W();
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="font:14px system-ui;margin:8px">${s.wrap(
    `<label class="${s.cls()}"><input type="checkbox" class="${s.cls()}" onchange="fetch('/consent?sid=${esc(sid)}&on='+this.checked,{method:'POST'})"> ${w.consent}</label>`,
  )}</body></html>`;
}

function pickupFrame() {
  const s = shaper("pickup");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body style="font:14px system-ui;margin:8px">${s.wrap(
    `<button type="button" class="${s.cls()}" onclick="this.nextElementSibling.textContent='Пункт выбран'">Выбрать пункт выдачи</button><span></span>`,
  )}</body></html>`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

const send = (res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}) =>
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers }).end(html);
const redirect = (res: ServerResponse, to: string) => res.writeHead(303, { location: to }).end();

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  let sid = /(?:^|;\s*)sid=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
  const cookie: Record<string, string> = {};
  if (!sid || !sessions.has(sid)) {
    sid ??= randomUUID();
    sessions.set(sid, { cart: [], consent: false });
    cookie["set-cookie"] = `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
  }
  const session = sessions.get(sid)!;

  if (route === "GET /") return send(res, 200, catalog(url.searchParams.get("q") ?? ""), cookie);
  if (route === "POST /cart/add") {
    const product = new URLSearchParams(await readBody(req)).get("product") ?? "";
    if (PRODUCTS.some((p) => p.id === product)) session.cart.push(product);
    return res.writeHead(303, { location: "/cart", ...cookie }).end();
  }
  if (route === "GET /cart") return send(res, 200, cart(session), cookie);
  if (route === "GET /checkout") return send(res, 200, checkout(sid, req.headers.host ?? `127.0.0.1:${port}`), cookie);
  if (route === "POST /order") {
    const form = new URLSearchParams(await readBody(req));
    const missing = ["name", "phone", "address", "delivery"].filter((f) => !form.get(f));
    if (session.cart.length === 0 || missing.length > 0 || !session.consent) {
      const why = session.cart.length === 0 ? "корзина пуста" : missing.length ? `не заполнено: ${missing.join(", ")}` : "нет согласия с условиями";
      return send(res, 422, doc("Ошибка оформления", `<p role="alert">Заказ не оформлен: ${why}</p><a href="/checkout">Вернуться</a>`, shaper("error")));
    }
    const order = { id: orders.length + 1, sid, items: session.cart, name: form.get("name")!, phone: form.get("phone")!, address: form.get("address")!, delivery: form.get("delivery")!, promo: form.get("promo") ?? "", comment: form.get("comment") ?? "" };
    orders.push(order);
    session.cart = [];
    session.consent = false;
    return redirect(res, `/order/${order.id}`);
  }
  const orderPage = /^GET \/order\/(\d+)$/.exec(route);
  if (orderPage) {
    const order = orders.find((o) => o.id === Number(orderPage[1]));
    if (!order) return send(res, 404, doc("Нет заказа", "<p>Такого заказа нет</p>", shaper("404")));
    const s = shaper("order");
    return send(res, 200, doc(`Заказ №${order.id} ${W().done}`, s.wrap(`<p class="${s.cls()}">Доставка: ${esc(order.delivery)}, ${esc(order.address)}</p>`), s));
  }
  if (route === "GET /help") return send(res, 200, doc("Помощь", "<p>Пишите в поддержку.</p>", shaper("help")));
  if (route === "GET /consent-frame") return send(res, 200, consentFrame(url.searchParams.get("sid") ?? ""));
  if (route === "POST /consent") {
    const target = sessions.get(url.searchParams.get("sid") ?? "");
    if (target) target.consent = url.searchParams.get("on") === "true";
    return res.writeHead(204).end();
  }
  if (route === "GET /pickup-frame") return send(res, 200, pickupFrame());

  // ---- test control ----
  if (route === "GET /api/orders") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(orders));
  if (route === "DELETE /api/orders") {
    orders.length = 0;
    sessions.clear();
    return res.writeHead(204).end();
  }
  if (route === "GET /api/layout") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(layout));
  if (route === "POST /api/layout") {
    layout = { ...layout, ...JSON.parse((await readBody(req)) || "{}") };
    return res.writeHead(204).end();
  }
  send(res, 404, doc("404", "<p>Нет такой страницы.</p>", shaper("404")));
}).listen(port, "127.0.0.1", () => console.log(`shapeshift-site on http://127.0.0.1:${port}`));

#!/usr/bin/env node
// A stand-in for ls-clicker in tests: the same files and arguments, no browser and no real sites.
// --signup --new-profile --go-live --fill-payments runs the next unprocessed input row (row N of output = row N of input).
// FAKE_LS_MS sets how long a row takes; a row whose first cell is "fail" exits with code 1.
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const arg = process.argv[2];
const version = "fake-ls-clicker 1.0";
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()) : []);
if (arg === "--version") {
  console.log(version);
  process.exit(0);
}
if (arg === "--plan") {
  writeFileSync("plan.json", JSON.stringify({ businessDetails: { "Legal business name": "next row" } }));
  process.exit(0);
}
const args = process.argv.slice(2);
const proxyAt = args.indexOf("--proxy");
const proxy = proxyAt >= 0 ? args.splice(proxyAt, 2)[1] : null;
if (args.join(" ") !== "--signup --new-profile --go-live --fill-payments") process.exit(2);
const input = lines("input.csv");
const done = Math.max(lines("output.csv").length - 1, 0);
const row = input[1 + done];
if (!row) {
  console.log("нет необработанных строк");
  process.exit(0);
}
const first = row.split(",")[0];
// Which proxy the row's profile got (the real engine binds it to the new Linken Sphere session).
writeFileSync("proxies.log", `${existsSync("proxies.log") ? readFileSync("proxies.log", "utf8") : ""}${done + 1} ${proxy ?? "-"}\n`);
// Like the real engine under BAP: providers only through the server, with the run's token.
if (process.env.BAP_RUN_TOKEN) {
  const call = async (path, body) => {
    const res = await fetch(`${process.env.BAP_SERVER}/api/v1/providers/${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${process.env.BAP_RUN_TOKEN}`, ...(body && { "content-type": "application/json" }) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  writeFileSync("provider.json", JSON.stringify({ server: process.env.BAP_SERVER, gotsms: await call("gotsms/api/account"), spokeo: await call("spokeo/phone-lookup", { phone: "415-712-3489" }) }));
}
console.log(`строка ${done + 1}: начинаю`);
writeFileSync("state.json", JSON.stringify({ node: "businessDetails", errors: [], ts: Date.now() / 1000, url: "https://qbo.example/businessdetails" }));
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LS_MS ?? 300)));
if (first === "fail") {
  console.log("• новый профиль: 0f0e0d0c-0b0a-4908-8706-050403020100");
  console.error("ОШИБКА: форма не принята");
  // Like the real engine: a dump of the page it stopped on.
  mkdirSync("failure", { recursive: true });
  writeFileSync("failure/page.json", JSON.stringify({ url: "https://qbo.example/otp", title: "Verify", reason: "форма не принята", headings: ["Enter the code"], alerts: ["That code didn't work."], elements: [{ tag: "button", text: "Resend code", id: "", testid: "", role: "", type: "", name: "", disabled: false, invalid: false, x: 0, y: 0, w: 80, h: 20 }] }));
  writeFileSync("failure/page.png", Buffer.alloc(200, 1));
  writeFileSync("failure/page.html", "<html><body><h1>Enter the code</h1></body></html>");
  process.exit(1);
}
const out = existsSync("output.csv") ? readFileSync("output.csv", "utf8") : "who,result\n";
writeFileSync("output.csv", `${out}${first},registered\n`);
console.log(`строка ${done + 1}: готово`);

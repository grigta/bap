// Placeholder test site for e2e tests.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url));
const port = Number(process.env.PORT ?? 4310);

createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
    return;
  }
  res.writeHead(404).end("not found");
}).listen(port, "127.0.0.1", () => console.log(`test-site on http://127.0.0.1:${port}`));

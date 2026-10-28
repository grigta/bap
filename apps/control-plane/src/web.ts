import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * The built panel (apps/web/dist) from the Control Plane itself: a file when one matches the path,
 * otherwise index.html, so the panel's own addresses (/runs/<id>) open directly. Hashed assets never change.
 */
export function webHandler(dir: string) {
  const root = normalize(dir) + sep;
  const index = join(root, "index.html");
  return (request: FastifyRequest, reply: FastifyReply) => {
    const path = decodeURIComponent(request.url.split("?")[0]!);
    const file = normalize(join(root, path));
    if (file.startsWith(root) && existsSync(file) && statSync(file).isFile()) {
      reply.header("cache-control", file.startsWith(join(root, "assets") + sep) ? "public, max-age=31536000, immutable" : "no-cache");
      return reply.type(TYPES[extname(file)] ?? "application/octet-stream").send(readFileSync(file));
    }
    return reply.header("cache-control", "no-cache").type(TYPES[".html"]!).send(readFileSync(index));
  };
}

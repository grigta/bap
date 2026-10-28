import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "@bap/database";
import { afterAll, afterEach, expect, test } from "vitest";
import { installCommand, publicEndpoint } from "../../apps/control-plane/src/agent-install.ts";
import { buildApp } from "../../apps/control-plane/src/app.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

const web = mkdtempSync(join(tmpdir(), "bap-web-"));
mkdirSync(join(web, "assets"));
writeFileSync(join(web, "index.html"), "<!doctype html><title>BAP</title>");
writeFileSync(join(web, "assets", "index-abc123.js"), "console.log('panel')");
writeFileSync(join(tmpdir(), "bap-secret.txt"), "outside the web directory");
const app = buildApp({ db: createDb("postgres://unused@127.0.0.1/unused"), store: memoryStore(), webDir: web });
afterAll(() => app.close());

test("the Control Plane serves the built panel: files, and index.html for the panel's own addresses", async () => {
  const index = await app.inject({ method: "GET", url: "/" });
  expect(index.statusCode).toBe(200);
  expect(index.headers["content-type"]).toMatch(/text\/html/);
  expect(index.body).toContain("<title>BAP</title>");
  const deepLink = await app.inject({ method: "GET", url: "/runs/1b9625e7-0000-4000-8000-000000000000?status=FAILED" });
  expect(deepLink.body).toContain("<title>BAP</title>");
  const asset = await app.inject({ method: "GET", url: "/assets/index-abc123.js" });
  expect(asset.headers["content-type"]).toMatch(/javascript/);
  expect(asset.headers["cache-control"]).toContain("immutable");
  expect(asset.body).toBe("console.log('panel')");
});

test("API misses stay JSON 404s, and nothing outside the web directory is served", async () => {
  const api = await app.inject({ method: "GET", url: "/api/v1/no-such-route" });
  expect(api.statusCode).toBe(404);
  expect(api.headers["content-type"]).toMatch(/json/);
  for (const url of ["/../bap-secret.txt", "/assets/../../bap-secret.txt", "/%2e%2e/bap-secret.txt"]) expect((await app.inject({ method: "GET", url })).body).not.toContain("outside the web directory");
});

afterEach(() => {
  delete process.env.BAP_PUBLIC_URL;
  delete process.env.BAP_PUBLIC_CERT_FILE;
});

test("a server with a self-signed certificate on its own address gets a pinned install command", () => {
  const dir = mkdtempSync(join(tmpdir(), "bap-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=bap", "-addext", "subjectAltName=IP:203.0.113.7", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  process.env.BAP_PUBLIC_URL = "https://203.0.113.7:9443/";
  process.env.BAP_PUBLIC_CERT_FILE = join(dir, "cert.pem");
  const pem = readFileSync(join(dir, "cert.pem"), "utf8");
  const pin = `sha256//${createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("base64")}`;
  expect(publicEndpoint()).toEqual({ url: "https://203.0.113.7:9443", pin, caPem: pem });
  expect(installCommand(publicEndpoint()!, "bapi_x")).toBe(`curl -fsSL --pinnedpubkey '${pin}' -k 'https://203.0.113.7:9443/install.sh' | bash -s -- 'bapi_x'`);
  // With a CA-signed certificate (a domain), no pinning is needed.
  delete process.env.BAP_PUBLIC_CERT_FILE;
  expect(publicEndpoint()).toEqual({ url: "https://203.0.113.7:9443", pin: null, caPem: null });
});

// Builds scenario bundles, puts them into S3 storage and registers id/version/sha256 with the Control Plane.
// Runs on a trusted machine or in CI: the API itself never receives code (REQ-SEC-003).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { buildScenarioBundle } from "./bundle.ts";

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`environment variable ${name} is required`);
  return value;
};
const server = env("BAP_SERVER", "http://127.0.0.1:3000").replace(/\/$/, "");
const token = env("BAP_API_TOKEN");
const bucket = env("S3_BUCKET", "bap");
const s3 = new S3Client({
  endpoint: env("S3_ENDPOINT", "http://127.0.0.1:8333"),
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: env("S3_ACCESS_KEY_ID", "bap"), secretAccessKey: env("S3_SECRET_ACCESS_KEY", "bap") },
});

const scenariosDir = resolve(process.argv[2] ?? "scenarios");
const outDir = resolve("dist/scenarios");
for (const name of readdirSync(scenariosDir).filter((d) => existsSync(join(scenariosDir, d, "index.ts")))) {
  const manifest = await buildScenarioBundle(join(scenariosDir, name, "index.ts"), outDir);
  const bundleKey = `scenarios/${manifest.file}`;
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: bundleKey, Body: readFileSync(join(outDir, manifest.file)), ContentType: "text/javascript" }));
  const res = await fetch(`${server}/api/v1/scenarios/${manifest.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ version: manifest.version, sha256: manifest.sha256, bundleKey }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${manifest.id}@${manifest.version}: ${body.error?.code} ${body.error?.message}`);
  console.log(`${manifest.id}@${manifest.version}  ${res.status === 201 ? "registered" : "already registered"}  sha256 ${manifest.sha256}`);
}

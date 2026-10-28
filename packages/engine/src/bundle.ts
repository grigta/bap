import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Scenario } from "@bap/scenario-sdk";

export interface BundleManifest {
  id: string;
  version: string;
  file: string;
  sha256: string;
}

export class BundleChecksumError extends Error {}

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Bundles a scenario module (default export) into `<id>@<version>.mjs` plus a checksum manifest. */
export async function buildScenarioBundle(entry: string, outDir: string): Promise<BundleManifest> {
  mkdirSync(outDir, { recursive: true });
  const tmp = join(outDir, `.build-${process.pid}-${Date.now()}.mjs`);
  // Loaded here, not at module load: agents only load bundles and ship without esbuild.
  const { build } = await import("esbuild");
  await build({ entryPoints: [entry], outfile: tmp, bundle: true, platform: "node", format: "esm", external: ["playwright-core"], logLevel: "silent" });
  const scenario: Scenario = (await import(pathToFileURL(tmp).href)).default;
  const file = `${scenario.id}@${scenario.version}.mjs`;
  renameSync(tmp, join(outDir, file));
  const manifest = { id: scenario.id, version: scenario.version, file, sha256: sha256(join(outDir, file)) };
  writeFileSync(join(outDir, `${scenario.id}@${scenario.version}.json`), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** Loads a bundle only if its bytes match the manifest checksum. */
export async function loadScenarioBundle(manifestPath: string): Promise<Scenario> {
  const manifest: BundleManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const file = join(dirname(manifestPath), manifest.file);
  const actual = sha256(file);
  if (actual !== manifest.sha256) throw new BundleChecksumError(`bundle ${manifest.file}: sha256 ${actual} does not match manifest ${manifest.sha256}`);
  const scenario: Scenario = (await import(`${pathToFileURL(file).href}?sha256=${actual}`)).default;
  if (scenario.id !== manifest.id || scenario.version !== manifest.version)
    throw new BundleChecksumError(`bundle ${manifest.file} contains ${scenario.id}@${scenario.version}`);
  return scenario;
}

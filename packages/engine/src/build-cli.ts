import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildScenarioBundle } from "./bundle.ts";

const scenariosDir = resolve(process.argv[2] ?? "scenarios");
const outDir = resolve(process.argv[3] ?? "dist/scenarios");
for (const name of readdirSync(scenariosDir).filter((d) => existsSync(join(scenariosDir, d, "index.ts")))) {
  const manifest = await buildScenarioBundle(join(scenariosDir, name, "index.ts"), outDir);
  console.log(`${manifest.file}  sha256 ${manifest.sha256}`);
}

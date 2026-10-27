import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDb } from "@bap/database";
import { buildApp } from "./app.ts";
import { buildPostmanCollection } from "./postman.ts";

// Routes are read without touching the database: Kysely connects lazily.
const app = buildApp({ db: createDb("postgres://unused@127.0.0.1/unused") });
const out = resolve(process.argv[2] ?? "docs/api/bap.postman_collection.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(await buildPostmanCollection(app), null, 2) + "\n");
await app.close();
console.log(`api:postman — ${out}`);

// Backup and restore of the Control Plane (REQ-OPS-001, ADR-0014): a pg_dump of PostgreSQL plus a
// mirror of the artifact store onto separate S3-compatible storage. Run daily by cron or launchd.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dumpDatabase, mirrorStore, pruneDumps, restoreDatabase } from "./backup.ts";
import { s3Store } from "./storage.ts";

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`environment variable ${name} is required`);
  return value;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const primary = () =>
  s3Store({ endpoint: env("S3_ENDPOINT", "http://127.0.0.1:8333"), bucket: env("S3_BUCKET", "bap"), accessKeyId: env("S3_ACCESS_KEY_ID", "bap"), secretAccessKey: env("S3_SECRET_ACCESS_KEY", "bap") });
const external = () =>
  s3Store({ endpoint: env("BACKUP_S3_ENDPOINT"), bucket: env("BACKUP_S3_BUCKET"), accessKeyId: env("BACKUP_S3_ACCESS_KEY_ID"), secretAccessKey: env("BACKUP_S3_SECRET_ACCESS_KEY") });

const [command, file] = process.argv.slice(2);
try {
  if (command === "backup") {
    const dir = resolve(env("BACKUP_DIR"));
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `bap-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
    // Overridable for PostgreSQL in a container, e.g. `docker compose exec -T postgres pg_dump -U bap -Fc bap`.
    const bytes = await dumpDatabase(env("PG_DUMP_CMD", 'pg_dump --format=custom --dbname "$DATABASE_URL"'), target);
    const pruned = pruneDumps(dir, Number(env("BACKUP_KEEP", "14")));
    // Without an external store configured, the dump is still taken; the panel's artifacts are not mirrored.
    const mirrored = process.env.BACKUP_S3_ENDPOINT ? await mirrorStore(await primary(), await external()) : "skipped: BACKUP_S3_* not set";
    console.log(JSON.stringify({ dump: target, bytes, pruned, objects: mirrored }));
  } else if (command === "restore") {
    if (!file) fail("usage: backup-cli restore <dump-file>");
    await restoreDatabase(env("PG_RESTORE_CMD", 'pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL"'), resolve(file!));
    const mirrored = await mirrorStore(await external(), await primary());
    console.log(JSON.stringify({ restored: resolve(file!), objects: mirrored }));
  } else fail("usage: backup-cli backup | restore <dump-file>");
} catch (e) {
  fail(`${command} failed: ${e instanceof Error ? e.message : String(e)}`);
}

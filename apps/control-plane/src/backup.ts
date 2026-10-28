import { spawn } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ObjectStore } from "./storage.ts";

/**
 * Copies objects the target does not have yet (REQ-OPS-001). Artifacts and bundles never change
 * under the same key, so a key present in the target is up to date; deletions are not mirrored.
 */
export async function mirrorStore(source: ObjectStore, target: ObjectStore): Promise<{ copied: number; total: number }> {
  const present = new Set(await target.list());
  const keys = await source.list();
  let copied = 0;
  for (const key of keys) {
    if (present.has(key)) continue;
    const object = await source.get(key);
    if (!object) continue; // deleted meanwhile (retention)
    await target.put(key, object.body, object.contentType);
    copied++;
  }
  return { copied, total: keys.length };
}

/** Runs a shell command with stdout into a file or stdin from a file; rejects with its stderr on failure. */
function shell(command: string, io: { stdoutTo?: string; stdinFrom?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdout = io.stdoutTo ? openSync(io.stdoutTo, "w") : "ignore";
    const stdin = io.stdinFrom ? openSync(io.stdinFrom, "r") : "ignore";
    const child = spawn("sh", ["-c", command], { stdio: [stdin, stdout, "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr = (stderr + c).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => {
      for (const fd of [stdout, stdin]) if (typeof fd === "number") closeSync(fd);
      if (code === 0) resolve();
      else reject(new Error(`\`${command.split(" ")[0]}\` exited with ${code}: ${stderr.trim()}`));
    });
  });
}

const DUMP_MAGIC = "PGDMP"; // pg_dump --format=custom

/** Dumps the database with `command` (custom format on stdout) into `file`, atomically. */
export async function dumpDatabase(command: string, file: string): Promise<number> {
  const partial = `${file}.partial`;
  try {
    await shell(command, { stdoutTo: partial });
    const head = Buffer.alloc(DUMP_MAGIC.length);
    const fd = openSync(partial, "r");
    readSync(fd, head, 0, head.length, 0);
    closeSync(fd);
    if (head.toString("latin1") !== DUMP_MAGIC) throw new Error(`${command.split(" ")[0]} did not produce a custom-format dump (use --format=custom)`);
    renameSync(partial, file); // a half-written dump never looks like a finished one
    return statSync(file).size;
  } finally {
    rmSync(partial, { force: true });
  }
}

export const restoreDatabase = (command: string, file: string) => shell(command, { stdinFrom: file });

/** Keeps the newest `keep` dumps in `dir`; returns the deleted file names. */
export function pruneDumps(dir: string, keep: number): string[] {
  const dumps = readdirSync(dir).filter((f) => /^bap-.*\.dump$/.test(f)).sort();
  const old = dumps.slice(0, Math.max(0, dumps.length - keep));
  for (const f of old) rmSync(join(dir, f));
  return old;
}

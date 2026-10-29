// The full check runs once per change: `stamp` remembers the tree a passing `pnpm verify:code` checked,
// `check` (the pre-push hook) succeeds when the pushed commit is exactly that tree, so it is not run twice.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STAMP = "reports/verified-tree";
const git = (args: string[], env: NodeJS.ProcessEnv = process.env) => execFileSync("git", args, { encoding: "utf8", env }).trim();

/** The tree the working copy would commit as (tracked and new files, .gitignore respected), without touching the index. */
function workingTree(): string {
  const index = join(tmpdir(), `verify-once-index-${process.pid}`);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(["read-tree", "HEAD"], env);
    git(["add", "-A"], env);
    return git(["write-tree"], env);
  } finally {
    rmSync(index, { force: true });
  }
}

const command = process.argv[2];
if (command === "stamp") {
  mkdirSync("reports", { recursive: true });
  writeFileSync(STAMP, `${workingTree()}\n`);
  console.log(`verify-once: checked tree ${readFileSync(STAMP, "utf8").trim().slice(0, 12)} stamped`);
} else if (command === "check") {
  const verified = existsSync(STAMP) ? readFileSync(STAMP, "utf8").trim() : "";
  const pushed = git(["rev-parse", "HEAD^{tree}"]);
  if (verified === pushed) {
    console.log(`verify-once: ${pushed.slice(0, 12)} already passed the full check; not running it again`);
    process.exit(0);
  }
  console.log("verify-once: this code has not passed the full check yet");
  process.exit(1);
} else {
  console.error("usage: verify-once stamp|check");
  process.exit(2);
}

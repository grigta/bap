import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const cli = resolve(import.meta.dirname, "../../tools/verify-once/src/cli.ts");

describe("full check once per change", () => {
  test("the pre-push check passes only for exactly the code the full check stamped", () => {
    const repo = mkdtempSync(join(tmpdir(), "verify-once-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    const run = (cmd: string) => spawnSync("node", [cli, cmd], { cwd: repo, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, ".gitignore"), "reports/\n");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "one");

    expect(run("check").status).toBe(1); // never checked
    // Checked before committing: the stamp is the tree the commit will have.
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    expect(run("stamp").status).toBe(0);
    git("add", "-A");
    git("commit", "-qm", "two");
    const passed = run("check");
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("not running it again");

    // Another change after the check: the push runs it.
    writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
    git("commit", "-qam", "three");
    expect(run("check").status).toBe(1);
  });
});

// The pre-push check: lint, types and unit tests for everything, integration and e2e tests only for what the push
// changes (see pick.ts). It stays within a few minutes; the full `pnpm verify:code` runs in CI on every push.
import { execFileSync, spawnSync } from "node:child_process";
import { pick } from "./pick.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const lines = (s: string) => s.split("\n").filter(Boolean);
const base = spawnSync("git", ["rev-parse", "--verify", "-q", "@{upstream}"], { encoding: "utf8" }).stdout.trim() || "origin/main";
const changed = lines(git("diff", "--name-only", "--diff-filter=d", `${base}...HEAD`));
const integration = pick(changed, lines(git("ls-files", "tests/integration/*.test.ts", "tests/recovery/*.test.ts")));
const specs = lines(git("ls-files", "tests/e2e/*.spec.ts"));
// e2e runs one spec at a time (~30 s each): when a change touches many specs, only those named after changed
// source files run here, so the push stays within ~5 minutes; CI runs every spec anyway.
const E2E_LIMIT = 4;
const touched = pick(changed, specs);
const e2e = touched.length > E2E_LIMIT ? pick(changed.filter((f) => !f.startsWith("tests/")), specs) : touched;

const run = (title: string, cmd: string, args: string[]) => {
  console.log(`verify-push: ${title}`);
  const done = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: "/var/run/docker.sock" } });
  if (done.status !== 0) process.exit(done.status ?? 1);
};
run("lint", "pnpm", ["exec", "eslint", "--cache", "--cache-location", "node_modules/.cache/eslint", "."]);
run("markdown", "pnpm", ["exec", "markdownlint-cli2"]);
run("types", "pnpm", ["-s", "typecheck"]);
run("unit", "pnpm", ["exec", "vitest", "run", "--project", "unit"]);
if (integration.length) run(`integration: ${integration.join(" ")}`, "pnpm", ["exec", "vitest", "run", "--project", "integration", ...integration]);
if (touched.length > e2e.length) console.log(`verify-push: ${touched.length - e2e.length} more e2e specs are left to CI`);
if (e2e.length) run(`e2e: ${e2e.join(" ")}`, "pnpm", ["exec", "playwright", "test", ...e2e]);
console.log("verify-push: ok — the full check runs in CI");

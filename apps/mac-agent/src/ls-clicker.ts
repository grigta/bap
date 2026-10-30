import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseCsv, toEngineCsv } from "@bap/csv";
import type { LsClickerState } from "@bap/protocol";

export class LsClickerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The full run of one row (ADR-0034); the number is found inside it, so nothing else may move the row cursor first. */
export const RUN_ARGS = ["--signup", "--new-profile", "--go-live", "--fill-payments"];
/** Lines of the engine's output kept for the operator. */
const TAIL = 200;
/** Lines of a failed run kept for «Недоработки». */
const FAILURE_LOG = 3000;

/** What is left of a failed run for «Недоработки»: the whole log, where the engine stood, the screen at the failure. */
export interface LsClickerFailure {
  position: number;
  startedAt: string;
  finishedAt: string;
  log: string[];
  stage: NonNullable<LsClickerState>["stage"];
  /** The Linken Sphere profile the run created, if it got that far. */
  lsProfile: string | null;
  /** The Mac's screen right after the failure (JPEG, base64), or null when it could not be taken. */
  screenshot: string | null;
}

/** The screen as it is (JPEG, ≤1600 px), or null without the Screen Recording permission. */
async function captureScreen(): Promise<string | null> {
  // Tests run on a developer's Mac: its screen is not theirs to take.
  if (process.env.BAP_NO_SCREENSHOT) return null;
  const file = join(tmpdir(), `bap-lsc-failure-${process.pid}.jpg`);
  try {
    await promisify(execFile)("screencapture", ["-x", "-t", "jpg", file], { timeout: 15_000 });
    await promisify(execFile)("sips", ["-Z", "1600", file], { timeout: 15_000 });
    const data = readFileSync(file);
    return data.length > 1000 ? data.toString("base64") : null;
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
/** Data rows of a CSV the way the engine counts them; a file it cannot parse counts as empty. */
const rowsOf = (text: string | null) => {
  if (!text?.trim()) return { columns: [] as string[], rows: [] as string[][] };
  try {
    return parseCsv(text);
  } catch {
    return { columns: [] as string[], rows: [] as string[][] };
  }
};
/** Written whole, then renamed: the engine never sees a half-written file. */
const writeAtomically = (path: string, data: string | Buffer, mode?: number) => {
  const tmp = `${path}.bap-${process.pid}`;
  writeFileSync(tmp, data);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, path);
};

/**
 * LS Clicker on this Mac (ADR-0034): BAP is its only control. The agent runs exactly
 * the full run of the next row — `ls-clicker --signup --new-profile --go-live --fill-payments`: a new
 * profile, a clean number for the row's state, the account, then setup and Payments. The engine picks the
 * next unprocessed row itself (the one after those in output.csv). The agent reports its state,
 * appends rows the operator sent to input.csv and installs the build the server rolls out.
 * Rows are only ever appended: row N of output.csv is the result of row N of input.csv.
 */
export function lsClicker(dir: string, opts: { download: (sha256: string) => Promise<Buffer>; log: (line: string) => void; serverUrl: string; caCert?: string }) {
  const bin = join(dir, "ls-clicker");
  const input = join(dir, "input.csv");
  const output = join(dir, "output.csv");
  let child: ChildProcess | null = null;
  let tail: string[] = [];
  let full: string[] = [];
  let failure: LsClickerFailure | null = null;
  const run = { running: false, startedAt: null as string | null, finishedAt: null as string | null, ok: null as boolean | null };
  let build: { key: string; sha256: string; version: string | null } | null = null;

  const running = () => {
    if (run.running) throw new LsClickerError("LS_CLICKER_RUNNING", "LS Clicker is already running a row on this Mac");
  };

  /** The binary's sha256 and --version, recomputed only when the file changes. */
  const binary = async () => {
    if (!existsSync(bin)) return { sha256: null, version: null };
    const st = statSync(bin);
    const key = `${st.size}:${st.mtimeMs}`;
    if (build?.key !== key) {
      const version = await promisify(execFile)(bin, ["--version"], { cwd: dir, timeout: 10_000 }).then(
        (r) => r.stdout.trim() || null,
        () => null,
      );
      build = { key, sha256: sha(readFileSync(bin)), version };
    }
    return { sha256: build.sha256, version: build.version };
  };

  const stage = (): NonNullable<LsClickerState>["stage"] => {
    try {
      const j = JSON.parse(read(join(dir, "state.json")) ?? "") as { node?: string; errors?: unknown[]; ts?: number; url?: string; assist?: unknown };
      return {
        node: String(j.node ?? ""),
        errors: (j.errors ?? []).map(String),
        ageSeconds: typeof j.ts === "number" ? Math.round(Date.now() / 1000 - j.ts) : null,
        url: String(j.url ?? ""),
        ...(j.assist !== undefined && { assist: j.assist }),
      };
    } catch {
      return null;
    }
  };

  return {
    /** Reported even before the first install: a new Mac shows up and gets the build rolled out. */
    async state(): Promise<LsClickerState> {
      const out = read(output);
      return { ...(await binary()), inputRows: rowsOf(read(input)).rows.length, outputRows: rowsOf(out).rows.length, outputHash: out === null ? null : sha(out), run: { ...run }, stage: stage() };
    },

    /** A Mac with an unprocessed row of its own runs that first; otherwise the operator's row is appended and run. */
    start(row?: { header: string[]; cells: string[]; proxy?: string }, token?: string, proxies: Record<string, string> = {}) {
      running();
      if (!existsSync(bin)) throw new LsClickerError("LS_CLICKER_MISSING", "ls-clicker is not installed on this Mac yet");
      const pending = rowsOf(read(input)).rows.length > rowsOf(read(output)).rows.length;
      if (!pending && !row) throw new LsClickerError("LS_CLICKER_NO_ROWS", "no unprocessed row on this Mac and none was given");
      const next = rowsOf(read(output)).rows.length;
      const appended = pending ? null : this.append(row!.header, row!.cells);
      // The row's proxy goes to its new Linken Sphere profile; the engine binds it before the start.
      const proxy = appended === null ? proxies[String(next)] : row!.proxy;
      tail = [];
      full = [];
      Object.assign(run, { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null });
      // The engine reaches its providers through the server with the run's token; no key is on this Mac (ADR-0035).
      const env = { ...process.env, ...(token && { BAP_SERVER: opts.serverUrl, BAP_RUN_TOKEN: token, ...(opts.caCert && { BAP_CA_CERT: opts.caCert }) }) };
      const p = spawn(bin, [...RUN_ARGS, ...(proxy ? ["--proxy", proxy] : [])], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      child = p;
      let rest = "";
      const onData = (chunk: Buffer) => {
        const lines = (rest + chunk.toString("utf8")).split("\n");
        rest = lines.pop() ?? "";
        const kept = lines.filter((l) => l.trim());
        tail = [...tail, ...kept].slice(-TAIL);
        full = [...full, ...kept].slice(-FAILURE_LOG);
      };
      p.stdout.on("data", onData);
      p.stderr.on("data", onData);
      const done = (ok: boolean, line?: string) => {
        if (!run.running || child !== p) return;
        const last = [rest, line ?? ""].filter((l) => l.trim());
        tail = [...tail, ...last].slice(-TAIL);
        full = [...full, ...last].slice(-FAILURE_LOG);
        const finishedAt = new Date().toISOString();
        if (!ok) {
          const log = full;
          const profile = log.map((l) => /новый профиль:\s*([0-9a-f-]{36})/i.exec(l)?.[1]).filter(Boolean).at(-1) ?? null;
          // The screen is taken before the run is reported finished: the server asks for the failure only then.
          void captureScreen().then((screenshot) => {
            failure = { position: next, startedAt: run.startedAt ?? finishedAt, finishedAt, log, stage: stage(), lsProfile: profile, screenshot };
            Object.assign(run, { running: false, finishedAt, ok });
          });
        } else Object.assign(run, { running: false, finishedAt, ok });
        child = null;
        opts.log(`ls-clicker finished: ${ok ? "ok" : "failed"}`);
      };
      p.on("error", (e) => done(false, `не запустился: ${e.message}`));
      p.on("exit", (code, signal) => done(code === 0, signal ? `остановлен (${signal})` : undefined));
      // The proxy itself is not logged: it carries a login and a password.
      opts.log(`ls-clicker started on ${appended === null ? "the Mac's own next row" : `row ${appended + 1}`}${proxy ? " with its proxy" : ""}`);
      return { started: true as const, appended };
    },

    stop() {
      if (!child) throw new LsClickerError("LS_CLICKER_IDLE", "LS Clicker is not running on this Mac");
      child.kill("SIGTERM");
      return { stopping: true as const };
    },

    log: () => ({ lines: tail }),

    /** The last failed run, for «Недоработки». */
    failure: () => ({ failure }),

    /** ls-clicker --plan writes plan.json for the next row; it is read here and goes to the operator only. */
    async plan() {
      if (!existsSync(bin)) throw new LsClickerError("LS_CLICKER_MISSING", "ls-clicker is not installed on this Mac yet");
      await promisify(execFile)(bin, ["--plan"], { cwd: dir, timeout: 30_000 }).catch(() => {});
      try {
        return { plan: JSON.parse(read(join(dir, "plan.json")) ?? "null") as unknown };
      } catch {
        return { plan: null };
      }
    },

    output() {
      const { columns, rows } = rowsOf(read(output));
      return { header: columns, rows };
    },

    /**
     * The operator's row goes to the end of input.csv, its values placed under input.csv's own column
     * names (order and extra columns do not matter). Returns the row's position, i.e. its line in output.csv.
     */
    append(header: string[], cells: string[]) {
      const existing = read(input);
      const parsed = rowsOf(existing);
      if (!existing?.trim()) {
        writeAtomically(input, toEngineCsv([header, cells]));
        return 0;
      }
      const norm = (c: string) => c.trim().toLowerCase();
      const at = parsed.columns.map((c) => header.findIndex((h) => norm(h) === norm(c)));
      // Values are never named in errors: they are the owner's employees' data.
      if (at.every((i) => i < 0)) throw new LsClickerError("LS_CLICKER_HEADER_MISMATCH", "no column of the table matches input.csv on this Mac");
      writeAtomically(input, (existing.endsWith("\n") ? existing : `${existing}\n`) + toEngineCsv([at.map((i) => (i < 0 ? "" : (cells[i] ?? "")))]));
      return parsed.rows.length;
    },

    async install(sha256: string) {
      running();
      const body = await opts.download(sha256);
      if (sha(body) !== sha256) throw new LsClickerError("LS_CLICKER_BUILD_MISMATCH", "the downloaded build does not match its sha256");
      mkdirSync(dir, { recursive: true });
      writeAtomically(bin, body, 0o755);
      build = null;
      opts.log(`ls-clicker build ${sha256.slice(0, 12)} installed`);
      return { sha256 };
    },
  };
}

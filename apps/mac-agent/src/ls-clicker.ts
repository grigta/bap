import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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

/** Lines of the engine's output kept for the operator. */
const TAIL = 200;
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
 * `ls-clicker --find-number --first-row` (the engine picks the next unprocessed row), reports its state,
 * appends rows the operator sent to input.csv and installs the build the server rolls out.
 * Rows are only ever appended: row N of output.csv is the result of row N of input.csv.
 */
export function lsClicker(dir: string, opts: { download: (sha256: string) => Promise<Buffer>; log: (line: string) => void; serverUrl: string; caCert?: string }) {
  const bin = join(dir, "ls-clicker");
  const input = join(dir, "input.csv");
  const output = join(dir, "output.csv");
  let child: ChildProcess | null = null;
  let tail: string[] = [];
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
    start(row?: { header: string[]; cells: string[] }, token?: string) {
      running();
      if (!existsSync(bin)) throw new LsClickerError("LS_CLICKER_MISSING", "ls-clicker is not installed on this Mac yet");
      const pending = rowsOf(read(input)).rows.length > rowsOf(read(output)).rows.length;
      if (!pending && !row) throw new LsClickerError("LS_CLICKER_NO_ROWS", "no unprocessed row on this Mac and none was given");
      const appended = pending ? null : this.append(row!.header, row!.cells);
      tail = [];
      Object.assign(run, { running: true, startedAt: new Date().toISOString(), finishedAt: null, ok: null });
      // The engine reaches its providers through the server with the run's token; no key is on this Mac (ADR-0035).
      const env = { ...process.env, ...(token && { BAP_SERVER: opts.serverUrl, BAP_RUN_TOKEN: token, ...(opts.caCert && { BAP_CA_CERT: opts.caCert }) }) };
      const p = spawn(bin, ["--find-number", "--first-row"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      child = p;
      let rest = "";
      const onData = (chunk: Buffer) => {
        const lines = (rest + chunk.toString("utf8")).split("\n");
        rest = lines.pop() ?? "";
        tail = [...tail, ...lines.filter((l) => l.trim())].slice(-TAIL);
      };
      p.stdout.on("data", onData);
      p.stderr.on("data", onData);
      const done = (ok: boolean, line?: string) => {
        if (!run.running || child !== p) return;
        if (rest.trim()) tail = [...tail, rest].slice(-TAIL);
        if (line) tail = [...tail, line].slice(-TAIL);
        Object.assign(run, { running: false, finishedAt: new Date().toISOString(), ok });
        child = null;
        opts.log(`ls-clicker finished: ${ok ? "ok" : "failed"}`);
      };
      p.on("error", (e) => done(false, `не запустился: ${e.message}`));
      p.on("exit", (code, signal) => done(code === 0, signal ? `остановлен (${signal})` : undefined));
      opts.log(appended === null ? "ls-clicker started on the Mac's own next row" : `ls-clicker started on row ${appended + 1}`);
      return { started: true as const, appended };
    },

    stop() {
      if (!child) throw new LsClickerError("LS_CLICKER_IDLE", "LS Clicker is not running on this Mac");
      child.kill("SIGTERM");
      return { stopping: true as const };
    },

    log: () => ({ lines: tail }),

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

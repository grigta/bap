import { execFileSync } from "node:child_process";
import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { type BrowserProvider, ProfileNotFoundError } from "@bap/browser-adapters";
import { AGENT_SOCKET_PATH, type AgentEvent, type AgentRequestPayload, type HeartbeatPayload, type RunAssignPayload, message, serverMessage } from "@bap/protocol";
import WebSocket from "ws";
import { AgentStore, type OutboxEvent } from "./agent-store.ts";
import { type EmitRunEvent, executeRun } from "./runner.ts";

export const AGENT_VERSION = "0.1.0";

class CodedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AgentOptions {
  serverUrl: string;
  agentKey: string;
  /** Browser provider on this Mac (Linken Sphere in production); null when there is none. */
  provider: BrowserProvider | null;
  providerName: string;
  maxSessions: number;
  /** Bundles, checkpoints and per-run artifacts. */
  dataDir: string;
  log?: (line: string) => void;
  maxReconnectDelayMs?: number;
}

export interface RunningAgent {
  /** Resolves when the agent stops for good: `revoked` means the server rejected its credentials. */
  stopped: Promise<"stopped" | "revoked">;
  stop(): void;
}

function cpuSampler() {
  const totals = () => cpus().reduce((acc, c) => {
    const t = c.times;
    acc.idle += t.idle;
    acc.total += t.idle + t.user + t.sys + t.nice + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
  let last = totals();
  return () => {
    const now = totals();
    const total = now.total - last.total;
    const busy = total > 0 ? 100 * (1 - (now.idle - last.idle) / total) : 0;
    last = now;
    return Math.round(busy * 10) / 10;
  };
}

/**
 * Memory in use the way Activity Monitor counts it (app + wired + compressed).
 * os.freemem() on macOS excludes the file cache, so it reads ~99% on any busy Mac.
 */
export function memoryPercent(vmStat = platform() === "darwin" ? execFileSync("vm_stat", { encoding: "utf8" }) : null, total = totalmem()): number {
  if (!vmStat) return Math.round(1000 * (1 - freemem() / total)) / 10;
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStat)?.[1]);
  const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vmStat)?.[1] ?? 0);
  const used = pages("Anonymous pages") - pages("Pages purgeable") + pages("Pages wired down") + pages("Pages occupied by compressor");
  return Math.round((1000 * used * pageSize) / total) / 10;
}

/** Connects out to the Control Plane (no listening ports) and keeps reconnecting until stopped or revoked. */
/**
 * Runs executing in this process, across agent instances. A restarted process starts empty, so only
 * runs of a dead process count as interrupted; an in-process restart (tests) does not kill live runs.
 */
const runningByDataDir = new Map<string, Set<string>>();

export function startAgent(opts: AgentOptions): RunningAgent {
  if (!runningByDataDir.has(opts.dataDir)) runningByDataDir.set(opts.dataDir, new Set());
  const runningInThisProcess = runningByDataDir.get(opts.dataDir)!;
  const log = opts.log ?? ((line: string) => console.log(line));
  const cpu = cpuSampler();
  const url = opts.serverUrl.replace(/^http/, "ws") + AGENT_SOCKET_PATH;
  const store = new AgentStore(opts.dataDir);
  let socket: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let delay = 1000;
  let finished = false;
  let finish!: (reason: "stopped" | "revoked") => void;
  const stopped = new Promise<"stopped" | "revoked">((resolve) => (finish = resolve));

  const end = (reason: "stopped" | "revoked") => {
    if (finished) return;
    finished = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.terminate();
    finish(reason);
  };

  const activeRuns = new Map<string, { cancelled: boolean }>();
  let agentId = "";

  const heartbeat = async (): Promise<HeartbeatPayload> => ({
    cpuPercent: cpu(),
    memoryPercent: memoryPercent(),
    lsAvailable: opts.provider ? await opts.provider.isAvailable() : false,
    activeSessions: activeRuns.size,
  });

  const handleRequest = async (req: AgentRequestPayload, requestId: string): Promise<unknown> => {
    const provider = opts.provider;
    if (!provider) throw new CodedError("PROVIDER_UNAVAILABLE", "this agent has no browser provider");
    if (req.method === "profiles.list") return provider.listProfiles();
    if (req.method === "profiles.check") return { state: await provider.profileState(req.externalId) };
    // Verify: the profile must open and close cleanly; the window appears briefly on this Mac.
    const session = await provider.openSession(req.externalId, `verify-${requestId}`);
    try {
      await session.attach();
      await session.getPage();
    } finally {
      await session.closeSession();
    }
    log(`verified profile ${req.externalId}`);
    return { verified: true };
  };

  // ---- outbox: run events and screenshots survive disconnects and agent restarts ----
  let liveSend: ((raw: object) => void) | null = null;
  let sentOnThisConnection = new Set<number>();
  let flushing = false;
  let flushAgain = false;
  const flush = async () => {
    if (flushing) return void (flushAgain = true);
    flushing = true;
    try {
      do {
        flushAgain = false;
        for (const item of store.pending()) {
          if (!liveSend || finished) return;
          if (item.kind === "artifact") {
            // In order: an event referring to a screenshot is sent only after the upload.
            const res = await fetch(`${opts.serverUrl}/api/v1/runs/${item.artifact.runId}/artifacts/${item.artifact.name}`, {
              method: "PUT",
              headers: { authorization: `Bearer ${opts.agentKey}`, "content-type": "image/png" },
              body: readFileSync(item.artifact.path),
            }).catch(() => null);
            if (res?.ok || res?.status === 404 || res?.status === 409) store.remove(item.rowId); // 404/409: the run is gone or final
            else return; // retried on the next flush
          } else if (!sentOnThisConnection.has(item.rowId)) {
            sentOnThisConnection.add(item.rowId);
            liveSend(item.event); // removed from the outbox when the server acknowledges the message id
          }
        }
      } while (flushAgain);
    } finally {
      flushing = false;
    }
  };
  const emit: EmitRunEvent = (event) => {
    store.enqueueEvent(message(event) as OutboxEvent);
    void flush();
  };

  // ---- runs that were executing when the previous agent process died ----
  const recoverInterrupted = async () => {
    for (const { runId, assign } of store.runs("running")) {
      if (runningInThisProcess.has(runId)) continue;
      store.setRun(runId, "interrupted");
      // The browser the crashed process left behind must not keep holding the profile.
      await opts.provider?.forceRelease(assign.profileExternalId).catch((e) => log(`could not release profile of ${runId}: ${e}`));
      log(`run ${runId} was interrupted by an agent restart`);
    }
  };
  const recovering = recoverInterrupted();

  const startRun = (assign: RunAssignPayload, provider: BrowserProvider) => {
    const control = { cancelled: false };
    activeRuns.set(assign.runId, control);
    runningInThisProcess.add(assign.runId);
    store.setRun(assign.runId, "running", assign);
    void executeRun(assign, { serverUrl: opts.serverUrl, agentKey: opts.agentKey, agentId, provider, dataDir: opts.dataDir, store, emit, isCancelled: () => control.cancelled, log }).finally(() => {
      activeRuns.delete(assign.runId);
      runningInThisProcess.delete(assign.runId);
      store.setRun(assign.runId, "finished");
    });
  };

  const onAssign = (assign: RunAssignPayload) => {
    const { runId } = assign;
    const provider = opts.provider;
    if (!provider) return emit({ type: "run.failed", payload: { runId, status: "FAILED", errorCode: "PROVIDER_UNAVAILABLE", message: "this agent has no browser provider" } });
    // A repeated assignment must never run the scenario twice.
    if (activeRuns.has(runId)) return emit({ type: "run.accepted", payload: { runId } });
    const known = store.runStatus(runId);
    if (known === null || (assign.resume && known === "interrupted")) return startRun(assign, provider);
    emit({ type: "run.failed", payload: { runId, status: "NEEDS_REVIEW", errorCode: "DUPLICATE_ASSIGNMENT", message: "this agent already executed the run; not repeating it" } });
  };

  const onCancel = (runId: string) => {
    const active = activeRuns.get(runId);
    if (active) {
      active.cancelled = true; // takes effect at the next step boundary
      log(`run ${runId}: cancel requested`);
    } else if (store.runStatus(runId) === "interrupted") {
      store.setRun(runId, "finished");
      emit({ type: "run.cancelled", payload: { runId, afterStep: null } });
    }
  };

  const connect = async () => {
    await recovering;
    if (finished) return;
    let seq = 0;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${opts.agentKey}` } });
    socket = ws;
    const send = (event: Omit<AgentEvent, "v" | "id" | "ts" | "seq">) => ws.send(JSON.stringify({ ...message(event), seq: ++seq }));

    ws.on("open", () =>
      ws.send(
        JSON.stringify(
          message({
            type: "agent.hello",
            payload: {
              agentVersion: AGENT_VERSION,
              platform: platform(),
              architecture: arch(),
              activeRuns: [...runningInThisProcess],
              interruptedRuns: store.runs("interrupted").map((r) => r.runId),
            },
          }),
        ),
      ),
    );
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        log("server rejected the agent credentials (401): re-enroll with a new invitation");
        end("revoked");
      } else log(`connection refused: HTTP ${res.statusCode}`);
      ws.terminate();
    });
    ws.on("message", async (raw) => {
      if (finished) return; // a stopped agent takes no more work
      const msg = serverMessage.parse(JSON.parse(String(raw)));
      if (msg.type === "server.welcome") {
        delay = 1000;
        agentId = msg.payload.agentId;
        log(`connected: epoch ${msg.payload.epoch}, heartbeat every ${msg.payload.heartbeatIntervalMs} ms`);
        send({ type: "agent.capabilities", payload: { providers: opts.provider ? [opts.providerName] : [], maxSessions: opts.maxSessions } });
        const beat = async () => send({ type: "agent.heartbeat", payload: await heartbeat() });
        await beat();
        heartbeatTimer = setInterval(() => void beat().catch((e) => log(`heartbeat failed: ${e}`)), msg.payload.heartbeatIntervalMs);
        // Everything not acknowledged before is sent again on this connection.
        sentOnThisConnection = new Set();
        liveSend = (event) => ws.send(JSON.stringify({ ...event, seq: ++seq }));
        void flush();
      } else if (msg.type === "server.ack") store.acknowledge(msg.payload.id);
      else if (msg.type === "run.assign") onAssign(msg.payload);
      else if (msg.type === "run.cancel") onCancel(msg.payload.runId);
      else if (msg.type === "server.request") {
        const respond = (payload: { ok: boolean; result?: unknown; error?: { code: string; message: string } }) =>
          ws.send(JSON.stringify(message({ type: "agent.response", payload: { requestId: msg.id, ...payload } })));
        try {
          respond({ ok: true, result: await handleRequest(msg.payload, msg.id) });
        } catch (e) {
          const code = e instanceof ProfileNotFoundError ? "PROFILE_NOT_FOUND" : e instanceof CodedError ? e.code : "PROVIDER_ERROR";
          respond({ ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } });
        }
      } else if (msg.type === "agent.drain") log(msg.payload.draining ? "drained: finishing current runs, no new ones" : "active again");
      else if (msg.type === "server.error") log(`server error ${msg.payload.code}: ${msg.payload.message}`);
    });
    ws.on("error", (e) => log(`connection error: ${e.message}`));
    ws.on("close", (code, reason) => {
      liveSend = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (finished) return;
      if (code === 4401) {
        log(`disconnected: ${reason}`);
        return end("revoked");
      }
      log(`disconnected (${code}); reconnecting in ${delay} ms`);
      reconnectTimer = setTimeout(() => void connect(), delay);
      delay = Math.min(delay * 2, opts.maxReconnectDelayMs ?? 10_000);
    });
  };

  void connect();
  return { stopped, stop: () => end("stopped") };
}

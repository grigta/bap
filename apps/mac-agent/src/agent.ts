import { execFileSync } from "node:child_process";
import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { readFileSync } from "node:fs";
import { type BrowserProvider, LinkenSphereStartError, ProfileNotFoundError } from "@bap/browser-adapters";
import { AGENT_SOCKET_PATH, type AgentEvent, type AgentRequestPayload, type HeartbeatPayload, type RunAssignPayload, message, serverMessage } from "@bap/protocol";
import WebSocket from "ws";
import { AgentStore, type OutboxEvent } from "./agent-store.ts";
import { checkServerUrl } from "./config.ts";
import { readModel } from "./model.ts";
import { readPower } from "./power.ts";
import { LsClickerError, lsClicker } from "./ls-clicker.ts";
import { remoteBrowser } from "./remote.ts";
import { devBuild, installBuild } from "./self-update.ts";
import { purgeLocalRuns } from "./retention.ts";
import { type EmitRunEvent, executeRun } from "./runner.ts";


const isLsClickerRequest = (r: AgentRequestPayload): r is Extract<AgentRequestPayload, { method: `lsclicker.${string}` }> => r.method.startsWith("lsclicker.");

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
  /** Persists a rotated key (keychain or file); called before the agent reconnects with it. */
  onKeyRotated?: (agentKey: string) => void;
  /** Browser provider on this Mac (Linken Sphere in production); null when there is none. */
  provider: BrowserProvider | null;
  providerName: string;
  maxSessions: number;
  /** Bundles, checkpoints and per-run artifacts. */
  dataDir: string;
  log?: (line: string) => void;
  maxReconnectDelayMs?: number;
  /**
   * Installed agents (one file from the installer): the server tells them to replace `file` with its
   * current build; `restart` then hands over to launchd. Agents run from a repository report "dev-<commit>".
   */
  selfUpdate?: { file: string; build: string; restart: () => void };
  /** Local data of settled runs is deleted after this many days (REQ-SEC-010); kept when omitted. */
  retentionDays?: number;
  /** The Mac model shown in the panel; read from system_profiler when omitted. */
  model?: string | null;
  /** LS Clicker's directory on this Mac (ADR-0034); null when BAP does not run LS Clicker here. */
  lsClickerDir?: string | null;
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
  checkServerUrl(opts.serverUrl);
  if (!runningByDataDir.has(opts.dataDir)) runningByDataDir.set(opts.dataDir, new Set());
  const runningInThisProcess = runningByDataDir.get(opts.dataDir)!;
  const log = opts.log ?? ((line: string) => console.log(line));
  const cpu = cpuSampler();
  const model = opts.model === undefined ? readModel() : opts.model;
  const clicker = opts.lsClickerDir
    ? lsClicker(opts.lsClickerDir, {
        log,
        serverUrl: opts.serverUrl,
        caCert: process.env.NODE_EXTRA_CA_CERTS,
        download: async (sha256) => {
          const res = await fetch(`${opts.serverUrl}/api/v1/agents/me/ls-clicker/build?sha256=${sha256}`, { headers: { authorization: `Bearer ${agentKey}` } });
          if (!res.ok) throw new LsClickerError("LS_CLICKER_DOWNLOAD_FAILED", `the server answered HTTP ${res.status} for the build`);
          return Buffer.from(await res.arrayBuffer());
        },
      })
    : null;
  const url = opts.serverUrl.replace(/^http/, "ws") + AGENT_SOCKET_PATH;
  const store = new AgentStore(opts.dataDir);
  let agentKey = opts.agentKey;
  let socket: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let retentionTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let delay = 1000;
  let finished = false;
  let finish!: (reason: "stopped" | "revoked") => void;
  const stopped = new Promise<"stopped" | "revoked">((resolve) => (finish = resolve));

  const end = (reason: "stopped" | "revoked") => {
    if (finished) return;
    finished = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (retentionTimer) clearInterval(retentionTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    socket?.terminate();
    finish(reason);
  };

  const activeRuns = new Map<string, { cancelled: boolean; profileExternalId: string }>();
  // The operator's remote browser goes over the live connection; frames are dropped while there is none.
  let liveSocket: WebSocket | null = null;
  const remote = remoteBrowser({
    provider: opts.provider,
    send: (msg, sent) => {
      if (liveSocket?.readyState !== WebSocket.OPEN) return;
      liveSocket.send(JSON.stringify(message(msg)), () => sent?.());
    },
    busyProfiles: () => new Set([...activeRuns.values()].map((r) => r.profileExternalId)),
    log,
  });
  let agentId = "";

  const heartbeat = async (): Promise<HeartbeatPayload> => ({
    cpuPercent: cpu(),
    memoryPercent: memoryPercent(),
    lsAvailable: opts.provider ? await opts.provider.isAvailable() : false,
    activeSessions: activeRuns.size,
    power: readPower(),
    lsClicker: clicker ? await clicker.state().catch(() => null) : null,
  });

  const handleRequest = async (req: AgentRequestPayload, requestId: string): Promise<unknown> => {
    if (isLsClickerRequest(req)) {
      if (!clicker) throw new CodedError("LS_CLICKER_UNAVAILABLE", "LS Clicker is not set up on this Mac");
      try {
        switch (req.method) {
          case "lsclicker.run":
            return clicker.start(req.row, req.token, req.proxies);
          case "lsclicker.stop":
            return clicker.stop();
          case "lsclicker.log":
            return clicker.log();
          case "lsclicker.plan":
            return await clicker.plan();
          case "lsclicker.output":
            return clicker.output();
          case "lsclicker.install":
            return await clicker.install(req.sha256);
        }
      } catch (e) {
        throw e instanceof LsClickerError ? new CodedError(e.code, e.message) : e;
      }
    }
    const provider = opts.provider;
    if (!provider) throw new CodedError("PROVIDER_UNAVAILABLE", "this agent has no browser provider");
    if (req.method === "provider.start") {
      if (!provider.start) throw new CodedError("PROVIDER_UNAVAILABLE", "this agent's browser provider has no app to start");
      const state = await provider.start().catch((e: unknown) => {
        throw e instanceof LinkenSphereStartError ? new CodedError(e.code, e.message) : e;
      });
      log(state === "started" ? "started Linken Sphere" : "Linken Sphere was already running");
      return { started: state === "started" };
    }
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
              headers: { authorization: `Bearer ${agentKey}`, "content-type": item.artifact.name.endsWith(".json") ? "application/octet-stream" : "image/png" },
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

  if (opts.retentionDays !== undefined) {
    const days = opts.retentionDays;
    const sweep = () => {
      try {
        const purged = purgeLocalRuns(store, opts.dataDir, new Date(Date.now() - days * 86_400_000));
        if (purged.length > 0) log(`deleted local data of ${purged.length} run(s) older than ${days} days`);
      } catch (e) {
        log(`retention sweep failed: ${e}`);
      }
    };
    void recovering.then(sweep);
    retentionTimer = setInterval(sweep, 3_600_000).unref();
  }

  const startRun = (assign: RunAssignPayload, provider: BrowserProvider) => {
    const control = { cancelled: false, profileExternalId: assign.profileExternalId };
    activeRuns.set(assign.runId, control);
    runningInThisProcess.add(assign.runId);
    store.setRun(assign.runId, "running", assign);
    void executeRun(assign, { serverUrl: opts.serverUrl, agentKey: () => agentKey, agentId, provider, dataDir: opts.dataDir, store, emit, isCancelled: () => control.cancelled, log }).finally(() => {
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
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${agentKey}` } });
    socket = ws;
    const send = (event: Omit<AgentEvent, "v" | "id" | "ts" | "seq">) => ws.send(JSON.stringify({ ...message(event), seq: ++seq }));

    ws.on("open", () =>
      ws.send(
        JSON.stringify(
          message({
            type: "agent.hello",
            payload: {
              agentVersion: opts.selfUpdate?.build ?? devBuild(),
              updatable: !!opts.selfUpdate,
              platform: platform(),
              architecture: arch(),
              model,
              // Runs finished while offline still count: their results are in the outbox and arrive next.
              // Otherwise the server could resume such a run before learning it already ended.
              // Interrupted runs never do: nothing executes them any more, whatever the outbox holds.
              activeRuns: [...new Set([...runningInThisProcess, ...store.finishedRunsWithUndeliveredEvents()])],
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
        liveSocket = ws;
        void flush();
      } else if (msg.type === "server.ack") store.acknowledge(msg.payload.id);
      else if (msg.type === "run.assign") onAssign(msg.payload);
      else if (msg.type === "run.cancel") onCancel(msg.payload.runId);
      else if (msg.type === "remote.open") void remote.open(msg.payload.sessionId, msg.payload.profileExternalId, msg.payload.startUrl);
      else if (msg.type === "remote.input") remote.input(msg.payload.sessionId, msg.payload.input);
      else if (msg.type === "remote.close") void remote.close(msg.payload.sessionId, "закрыта оператором");
      else if (msg.type === "agent.update") {
        const update = opts.selfUpdate;
        // The server offers it only when idle; a run that arrived since then is finished first (offered again later).
        if (!update || activeRuns.size > 0) return;
        try {
          const build = await installBuild(opts.serverUrl, agentKey, update.file, msg.payload.sha256);
          log(`updated to ${build}; restarting`);
          end("stopped");
          update.restart();
        } catch (e) {
          log(`update failed, staying on ${update.build}: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (msg.type === "agent.rotate-key") {
        const res = await fetch(`${opts.serverUrl}/api/v1/agents/me/key`, { method: "POST", headers: { authorization: `Bearer ${agentKey}` } });
        if (!res.ok) return log(`key rotation failed: HTTP ${res.status}`);
        const { agentKey: rotated } = (await res.json()) as { agentKey: string };
        opts.onKeyRotated?.(rotated); // persisted first: a crash now must not lose the only valid key
        agentKey = rotated;
        log("agent key rotated; reconnecting with the new key");
        ws.close(1000, "key rotated");
      }
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
      liveSocket = null;
      // Nobody can watch or close the browser any more: it must not stay open holding the profile.
      void remote.closeAll("агент потерял связь с сервером");
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

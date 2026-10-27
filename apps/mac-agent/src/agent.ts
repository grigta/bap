import { execFileSync } from "node:child_process";
import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { LinkenSphereProvider } from "@bap/browser-adapters";
import { AGENT_SOCKET_PATH, type AgentEvent, type HeartbeatPayload, message, serverMessage } from "@bap/protocol";
import WebSocket from "ws";

export const AGENT_VERSION = "0.1.0";

export interface AgentOptions {
  serverUrl: string;
  agentKey: string;
  /** Linken Sphere Local API; null when this Mac has none. */
  lsApiUrl: string | null;
  maxSessions: number;
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
export function startAgent(opts: AgentOptions): RunningAgent {
  const log = opts.log ?? ((line: string) => console.log(line));
  const ls = opts.lsApiUrl ? new LinkenSphereProvider({ apiUrl: opts.lsApiUrl, timeoutMs: 2000 }) : null;
  const cpu = cpuSampler();
  const url = opts.serverUrl.replace(/^http/, "ws") + AGENT_SOCKET_PATH;
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
    socket?.close();
    finish(reason);
  };

  const heartbeat = async (): Promise<HeartbeatPayload> => ({
    cpuPercent: cpu(),
    memoryPercent: memoryPercent(),
    lsAvailable: ls ? await ls.isAvailable() : false,
    activeSessions: 0,
  });

  const connect = () => {
    let seq = 0;
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${opts.agentKey}` } });
    socket = ws;
    const send = (event: Omit<AgentEvent, "v" | "id" | "ts" | "seq">) => ws.send(JSON.stringify({ ...message(event), seq: ++seq }));

    ws.on("open", () => ws.send(JSON.stringify(message({ type: "agent.hello", payload: { agentVersion: AGENT_VERSION, platform: platform(), architecture: arch() } }))));
    ws.on("unexpected-response", (_req, res) => {
      if (res.statusCode === 401) {
        log("server rejected the agent credentials (401): re-enroll with a new invitation");
        end("revoked");
      } else log(`connection refused: HTTP ${res.statusCode}`);
      ws.terminate();
    });
    ws.on("message", async (raw) => {
      const msg = serverMessage.parse(JSON.parse(String(raw)));
      if (msg.type === "server.welcome") {
        delay = 1000;
        log(`connected: epoch ${msg.payload.epoch}, heartbeat every ${msg.payload.heartbeatIntervalMs} ms`);
        send({ type: "agent.capabilities", payload: { providers: ls ? ["linken-sphere"] : [], maxSessions: opts.maxSessions } });
        const beat = async () => send({ type: "agent.heartbeat", payload: await heartbeat() });
        await beat();
        heartbeatTimer = setInterval(() => void beat().catch((e) => log(`heartbeat failed: ${e}`)), msg.payload.heartbeatIntervalMs);
      } else if (msg.type === "server.error") log(`server error ${msg.payload.code}: ${msg.payload.message}`);
    });
    ws.on("error", (e) => log(`connection error: ${e.message}`));
    ws.on("close", (code, reason) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (finished) return;
      if (code === 4401) {
        log(`disconnected: ${reason}`);
        return end("revoked");
      }
      log(`disconnected (${code}); reconnecting in ${delay} ms`);
      reconnectTimer = setTimeout(connect, delay);
      delay = Math.min(delay * 2, opts.maxReconnectDelayMs ?? 10_000);
    });
  };

  connect();
  return { stopped, stop: () => end("stopped") };
}

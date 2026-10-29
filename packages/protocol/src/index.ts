import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const envelope = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.uuid(),
  ts: z.iso.datetime(),
};
/** Agent events carry a sequence number, unique within the epoch the server issued on hello. */
const event = { ...envelope, seq: z.number().int().positive() };

export const agentHello = z.object({
  ...envelope,
  type: z.literal("agent.hello"),
  payload: z.object({
    /** The build: 12 hex of the agent file's sha256 when installed, "dev-<commit>" from a repository. */
    agentVersion: z.string(),
    /** Installed with the one-line installer: it can replace itself with the server's current build. */
    updatable: z.boolean().default(false),
    platform: z.string(),
    architecture: z.string(),
    /** The Mac as people call it, e.g. "MacBook Air · Apple M5 · 16 GB"; null when unknown. */
    model: z.string().nullable().default(null),
    /** Runs executing right now on this agent (they survive a dropped connection). */
    activeRuns: z.array(z.uuid()).default([]),
    /** Runs that were executing when the agent process died; their sessions have been closed. */
    interruptedRuns: z.array(z.uuid()).default([]),
  }),
});

export const agentCapabilities = z.object({
  ...event,
  type: z.literal("agent.capabilities"),
  payload: z.object({ providers: z.array(z.string()), maxSessions: z.number().int().nonnegative() }),
});

/** Power of the Mac: an unattended node must stay on the charger and must not sleep. */
export const powerState = z.object({
  source: z.enum(["ac", "battery", "unknown"]),
  batteryPercent: z.number().min(0).max(100).nullable(),
  charging: z.boolean().nullable(),
  /** System sleep is off (pmset sleep 0 or SleepDisabled, which also covers a closed lid). */
  sleepPrevented: z.boolean().nullable(),
});
export type PowerState = z.infer<typeof powerState>;

export const heartbeatPayload = z.object({
  cpuPercent: z.number().min(0).max(100),
  memoryPercent: z.number().min(0).max(100),
  lsAvailable: z.boolean(),
  activeSessions: z.number().int().nonnegative(),
  /** null off macOS; absent from agents older than this field. */
  power: powerState.nullable().optional(),
});
export type HeartbeatPayload = z.infer<typeof heartbeatPayload>;

export const agentHeartbeat = z.object({ ...event, type: z.literal("agent.heartbeat"), payload: heartbeatPayload });

export const stepRecord = z.object({
  sequence: z.number().int().positive(),
  stepId: z.string(),
  mutating: z.boolean(),
  status: z.enum(["passed", "failed", "unverified"]),
  startedAt: z.iso.datetime(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
  /** Name of the artifact uploaded before this event. */
  screenshot: z.string().optional(),
  intent: z.string().optional(),
  /** Recipes: found by fingerprint, healed, confirmed by the operator, or recorded. */
  resolution: z.enum(["found", "healed", "confirmed", "recorded"]).optional(),
  note: z.string().optional(),
});
export type StepRecordMessage = z.infer<typeof stepRecord>;

const runId = { runId: z.uuid() };
export const runAccepted = z.object({ ...event, type: z.literal("run.accepted"), payload: z.object(runId) });
export const runStarted = z.object({
  ...event,
  type: z.literal("run.started"),
  payload: z.object({ ...runId, autoResume: z.boolean(), resumedAfter: z.string().nullable().default(null) }),
});
export const runCheckpoint = z.object({
  ...event,
  type: z.literal("run.checkpoint"),
  payload: z.object({
    ...runId,
    sequence: z.number().int().positive(),
    stepId: z.string(),
    nextStepId: z.string().nullable(),
    nextStepMutating: z.boolean(),
    autoResume: z.boolean(),
    createdAt: z.iso.datetime(),
  }),
});
export const runCancelled = z.object({ ...event, type: z.literal("run.cancelled"), payload: z.object({ ...runId, afterStep: z.string().nullable() }) });
export const runProgress = z.object({ ...event, type: z.literal("run.progress"), payload: z.object({ ...runId, step: stepRecord }) });
export const runCompleted = z.object({ ...event, type: z.literal("run.completed"), payload: z.object(runId) });
export const runFailed = z.object({
  ...event,
  type: z.literal("run.failed"),
  payload: z.object({ ...runId, status: z.enum(["FAILED", "NEEDS_REVIEW"]), errorCode: z.string(), message: z.string() }),
});

/** Server → agent request; the agent answers with agent.response carrying the same requestId. */
export const agentRequestPayload = z.discriminatedUnion("method", [
  z.object({ method: z.literal("profiles.list") }),
  z.object({ method: z.literal("profiles.verify"), externalId: z.string().min(1) }),
  /** Cheap check after a run: is the profile there and released by the browser? */
  z.object({ method: z.literal("profiles.check"), externalId: z.string().min(1) }),
  /** Starts the browser provider app (Linken Sphere) and answers once its API responds. */
  z.object({ method: z.literal("provider.start") }),
]);
export type AgentRequestPayload = z.infer<typeof agentRequestPayload>;

export const agentResponse = z.object({
  ...envelope,
  type: z.literal("agent.response"),
  payload: z.object({
    requestId: z.uuid(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
});

export const agentMessage = z.discriminatedUnion("type", [
  agentHello,
  agentCapabilities,
  agentHeartbeat,
  agentResponse,
  runAccepted,
  runStarted,
  runProgress,
  runCompleted,
  runFailed,
  runCheckpoint,
  runCancelled,
]);
export type AgentMessage = z.infer<typeof agentMessage>;
/** Messages that are logged and deduplicated by (epoch, sequence). */
export type AgentEvent = Exclude<AgentMessage, z.infer<typeof agentHello> | z.infer<typeof agentResponse>>;
export type RunEvent = Extract<AgentEvent, { type: `run.${string}` }>;

export const serverWelcome = z.object({
  ...envelope,
  type: z.literal("server.welcome"),
  payload: z.object({ agentId: z.uuid(), epoch: z.number().int().positive(), heartbeatIntervalMs: z.number().int().positive() }),
});
export const serverAck = z.object({ ...envelope, type: z.literal("server.ack"), payload: z.object({ id: z.uuid(), duplicate: z.boolean() }) });
export const serverError = z.object({ ...envelope, type: z.literal("server.error"), payload: z.object({ code: z.string(), message: z.string() }) });

export const serverRequest = z.object({ ...envelope, type: z.literal("server.request"), payload: agentRequestPayload });

export const runAssign = z.object({
  ...envelope,
  type: z.literal("run.assign"),
  payload: z.object({
    runId: z.uuid(),
    /** bundle: JS module; recipe: recipe JSON. Both are fetched from the bundle route and checked by sha256. */
    scenario: z.object({ id: z.string(), version: z.string(), sha256: z.string(), kind: z.enum(["bundle", "recipe", "farm"]).default("bundle") }),
    /** Set for a recording: the agent explores the site with the server instead of running a scenario. */
    recording: z.object({ startUrl: z.url(), secretInputs: z.array(z.string()) }).optional(),
    profileExternalId: z.string(),
    input: z.unknown(),
    timeoutMs: z.number().int().positive(),
    /** Continue from the agent's last checkpoint instead of starting over. */
    resume: z.boolean().default(false),
  }),
});
export type RunAssignPayload = z.infer<typeof runAssign>["payload"];

/** The operator drained the agent: it keeps its runs but gets no new ones. */
export const agentDrain = z.object({ ...envelope, type: z.literal("agent.drain"), payload: z.object({ draining: z.boolean() }) });

/** Stop at the next step boundary; a mutating step in progress finishes and is verified first. */
export const runCancel = z.object({ ...envelope, type: z.literal("run.cancel"), payload: z.object({ runId: z.uuid() }) });

/** The operator asked for a new agent key: the agent fetches one with its current key and reconnects. */
export const agentRotateKey = z.object({ ...envelope, type: z.literal("agent.rotate-key"), payload: z.object({}) });

/** The server has a newer agent build: fetch it with the agent key, verify this sha256, restart on it. */
export const agentUpdate = z.object({ ...envelope, type: z.literal("agent.update"), payload: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }) });

export const serverMessage = z.discriminatedUnion("type", [serverWelcome, serverAck, serverError, serverRequest, runAssign, agentDrain, runCancel, agentRotateKey, agentUpdate]);
export type ServerMessage = z.infer<typeof serverMessage>;

/** Builds a message with a fresh envelope. */
export function message<T extends { type: string; payload: unknown }>(body: T): T & { v: typeof PROTOCOL_VERSION; id: string; ts: string } {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: new Date().toISOString(), ...body };
}

export const AGENT_SOCKET_PATH = "/api/v1/agents/connect";

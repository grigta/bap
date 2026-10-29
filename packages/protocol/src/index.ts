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

/** What a Mac's agent reports about LS Clicker there; null when the Mac has no LS Clicker directory. */
export const lsClickerState = z
  .object({
    /** `ls-clicker --version`, and the binary's sha256 (what BAP rolls out). */
    version: z.string().nullable(),
    sha256: z.string().nullable(),
    inputRows: z.number().int().nonnegative(),
    outputRows: z.number().int().nonnegative(),
    /** Changes whenever output.csv does: the server fetches it then. */
    outputHash: z.string().nullable(),
    run: z.object({ running: z.boolean(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), ok: z.boolean().nullable() }),
    /** The engine's live heartbeat (state.json): where on the site it is, its errors, how fresh. */
    stage: z.object({ node: z.string(), errors: z.array(z.string()), ageSeconds: z.number().nullable(), url: z.string(), assist: z.unknown().optional() }).nullable(),
  })
  .nullable();
export type LsClickerState = z.infer<typeof lsClickerState>;

export const heartbeatPayload = z.object({
  cpuPercent: z.number().min(0).max(100),
  memoryPercent: z.number().min(0).max(100),
  lsAvailable: z.boolean(),
  activeSessions: z.number().int().nonnegative(),
  /** null off macOS; absent from agents older than this field. */
  power: powerState.nullable().optional(),
  /** LS Clicker on this Mac; absent from agents older than this field. */
  lsClicker: lsClickerState.optional(),
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
  /** Failed steps: name of the uploaded failure.json (the page at that moment). */
  failure: z.string().optional(),
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
  // ---- LS Clicker on this Mac (ADR-0034): BAP runs it, the agent executes; the command and row choice are fixed ----
  /**
   * Starts the next row. With `row` (the operator's next table row) the agent first appends it to
   * input.csv, matched to its header by column names, unless the Mac still has an unprocessed row of its own.
   */
  z.object({
    method: z.literal("lsclicker.run"),
    row: z.object({ header: z.array(z.string()), cells: z.array(z.string()) }).optional(),
    /** The run's token: the engine calls its providers through the server with it (ADR-0035). */
    token: z.string().optional(),
  }),
  z.object({ method: z.literal("lsclicker.stop") }),
  /** The latest lines of the engine's output. */
  z.object({ method: z.literal("lsclicker.log") }),
  /** The input plan for the next row (ls-clicker --plan → plan.json): for the operator only. */
  z.object({ method: z.literal("lsclicker.plan") }),
  /** output.csv as it is: header and rows; row N is the result of input row N. */
  z.object({ method: z.literal("lsclicker.output") }),
  /** Installs the server's ls-clicker build with this sha256 (not during a run). */
  z.object({ method: z.literal("lsclicker.install"), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
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

// ---- Remote browser (REQ-AGENT-005): the operator works in a profile's browser from the panel ----
// Not run events: no sequence, no outbox, not stored; a lost frame is replaced by the next one.
const sessionId = { sessionId: z.uuid() };
export const remoteOpened = z.object({ ...envelope, type: z.literal("remote.opened"), payload: z.object(sessionId) });
export const remoteFailed = z.object({ ...envelope, type: z.literal("remote.failed"), payload: z.object({ ...sessionId, code: z.string(), message: z.string() }) });
/** One screencast frame of the page (JPEG, base64), in CSS pixels of the viewport. */
export const remoteFrame = z.object({ ...envelope, type: z.literal("remote.frame"), payload: z.object({ ...sessionId, data: z.string(), width: z.number(), height: z.number() }) });
export const remotePage = z.object({ ...envelope, type: z.literal("remote.page"), payload: z.object({ ...sessionId, url: z.string(), title: z.string() }) });
export const remoteClosed = z.object({ ...envelope, type: z.literal("remote.closed"), payload: z.object({ ...sessionId, reason: z.string() }) });
export type RemoteAgentMessage = z.infer<typeof remoteOpened> | z.infer<typeof remoteFailed> | z.infer<typeof remoteFrame> | z.infer<typeof remotePage> | z.infer<typeof remoteClosed>;

/** What the operator does in the remote browser; coordinates are CSS pixels of the page. */
export const remoteInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), x: z.number(), y: z.number(), button: z.enum(["left", "right", "middle"]).default("left"), clickCount: z.number().int().min(1).max(3).default(1) }),
  z.object({ kind: z.literal("move"), x: z.number(), y: z.number() }),
  z.object({ kind: z.literal("wheel"), x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number() }),
  /** A key by its KeyboardEvent.key name (Enter, Backspace, ArrowDown, a, …), with modifiers held. */
  z.object({ kind: z.literal("key"), key: z.string().min(1).max(32), modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).default([]) }),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ kind: z.literal("goto"), url: z.url() }),
  z.object({ kind: z.literal("back") }),
  z.object({ kind: z.literal("forward") }),
  z.object({ kind: z.literal("reload") }),
]);
export type RemoteInput = z.infer<typeof remoteInput>;

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
  remoteOpened,
  remoteFailed,
  remoteFrame,
  remotePage,
  remoteClosed,
]);
export type AgentMessage = z.infer<typeof agentMessage>;
/** Messages that are logged and deduplicated by (epoch, sequence). */
export type AgentEvent = Exclude<AgentMessage, z.infer<typeof agentHello> | z.infer<typeof agentResponse> | RemoteAgentMessage>;
export type RunEvent = Extract<AgentEvent, { type: `run.${string}` }>;
export const isRemoteMessage = (m: AgentMessage): m is RemoteAgentMessage => m.type.startsWith("remote.");

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

/** Open the profile's browser for the operator; startUrl is where the failed run stopped. */
export const remoteOpen = z.object({
  ...envelope,
  type: z.literal("remote.open"),
  payload: z.object({ sessionId: z.uuid(), profileExternalId: z.string(), startUrl: z.string().nullable() }),
});
export const remoteInputMessage = z.object({ ...envelope, type: z.literal("remote.input"), payload: z.object({ sessionId: z.uuid(), input: remoteInput }) });
export const remoteClose = z.object({ ...envelope, type: z.literal("remote.close"), payload: z.object({ sessionId: z.uuid() }) });

export const serverMessage = z.discriminatedUnion("type", [serverWelcome, serverAck, serverError, serverRequest, runAssign, agentDrain, runCancel, agentRotateKey, agentUpdate, remoteOpen, remoteInputMessage, remoteClose]);
export type ServerMessage = z.infer<typeof serverMessage>;

/** Builds a message with a fresh envelope. */
export function message<T extends { type: string; payload: unknown }>(body: T): T & { v: typeof PROTOCOL_VERSION; id: string; ts: string } {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: new Date().toISOString(), ...body };
}

export const AGENT_SOCKET_PATH = "/api/v1/agents/connect";

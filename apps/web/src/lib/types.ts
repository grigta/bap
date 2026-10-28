// Shapes of the Control Plane API as the panel uses them.

export interface Power {
  source: "ac" | "battery" | "unknown";
  batteryPercent: number | null;
  charging: boolean | null;
  sleepPrevented: boolean | null;
}

export interface Heartbeat {
  cpuPercent: number;
  memoryPercent: number;
  lsAvailable: boolean;
  activeSessions: number;
  /** null off macOS; absent from older agents. */
  power?: Power | null;
}

export type AgentStatus = "ACTIVE" | "DRAINING" | "DISABLED" | "REVOKED";
export type Connection = "ONLINE" | "SUSPECT" | "OFFLINE";

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  connection: Connection;
  lastSeenAt: string | null;
  /** The build: 12 hex for installed agents, "dev-<commit>" for agents run from a repository. */
  agentVersion: string | null;
  /** Installed agents: on the server's current build; null when run from a repository. */
  upToDate: boolean | null;
  heartbeat: Heartbeat | null;
  maxSessions: number | null;
  reportedMaxSessions: number | null;
  sessionLimit: number | null;
  activeRuns: number;
  duplicateMessages: number;
}
export type AgentCard = Agent & { heartbeats: (Heartbeat & { at: string })[] };

export type ProfileStatus = "AVAILABLE" | "RESERVED" | "IN_USE" | "VERIFYING" | "NEEDS_REVIEW" | "DISABLED";
export interface Profile {
  id: string;
  name: string;
  externalProfileId: string;
  agentName: string;
  agentConnection: Connection;
  status: ProfileStatus;
  assignable: boolean;
  activeRunId: string | null;
  lastError: string | null;
  lastVerifiedAt: string | null;
}

export const RUN_STATUSES = ["QUEUED", "ASSIGNED", "ACCEPTED", "RUNNING", "CANCEL_REQUESTED", "RECOVERY_PENDING", "SUCCEEDED", "FAILED", "NEEDS_REVIEW", "CANCELLED"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const FINAL_RUN: RunStatus[] = ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"];
export const CANCELLABLE_RUN: RunStatus[] = ["QUEUED", "ASSIGNED", "ACCEPTED", "RUNNING", "RECOVERY_PENDING"];

export interface Run {
  id: string;
  scenarioId: string;
  /** null while a recording has not produced its version. */
  scenarioVersion: string | null;
  /** record: a recipe being recorded. */
  kind: "run" | "record";
  profileId: string;
  agentId: string;
  status: RunStatus;
  errorCode: string | null;
  errorMessage: string | null;
  queueReason: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
export type RunDetail = Run & {
  transitions: { from: string | null; to: string; reason: string | null; at: string }[];
  checkpoints: { sequence: number; stepId: string }[];
};
export interface Step {
  sequence: number;
  stepId: string;
  mutating: boolean;
  status: "passed" | "failed" | "unverified";
  durationMs: number;
  error: string | null;
  screenshotArtifactId: string | null;
  intent: string | null;
  resolution: StepResolution | null;
  note: string | null;
}
export type StepResolution = "found" | "healed" | "confirmed" | "recorded";

export interface RecipeVersion {
  version: string;
  origin: "bundle" | "manual" | "recorded" | "healed";
  publishedAt: string | null;
  createdAt: string;
  sourceRunId: string | null;
  parentVersion: string | null;
  note: string | null;
}
export interface RecipeSummary {
  id: string;
  goal: string;
  startUrl: string;
  inputs: { name: string; secret: boolean }[];
  createdAt: string;
  versions: RecipeVersion[];
  lastRecording: { runId: string; status: RunStatus; createdAt: string } | null;
}
export interface RecipeStep {
  id: string;
  intent: string;
  action: "click" | "fill" | "select" | "press" | "navigate" | "wait" | "extract";
  target?: { role: string; name: string; text: string; context: string; frame: string };
  value?: string;
  mutating: boolean;
  postcondition?: { url?: string; text?: string };
  screenshot?: string;
}
export interface RecipeBody {
  goal: string;
  startUrl: string;
  steps: RecipeStep[];
}
export interface PendingConfirmation {
  stepId: string;
  intent: string;
  screenshotArtifactId: string | null;
}

export interface ReviewQueue {
  runs: { id: string; scenarioId: string; status: string; errorCode: string | null; errorMessage: string | null; finishedAt: string | null }[];
  profiles: { id: string; name: string; agentName: string; lastError: string | null; updatedAt: string }[];
}

export interface AuditEvent {
  at: string;
  actor: string;
  action: string;
  outcome: "ok" | "denied";
  targetType: string | null;
  targetId: string | null;
  details: { status?: number; login?: string; name?: string };
}

export interface Health {
  status: "ok" | "degraded";
  database: "up" | "down";
}

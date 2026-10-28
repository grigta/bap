// Shapes of the Control Plane API as the panel uses them.

export interface Heartbeat {
  cpuPercent: number;
  memoryPercent: number;
  lsAvailable: boolean;
  activeSessions: number;
}

export type AgentStatus = "ACTIVE" | "DRAINING" | "DISABLED" | "REVOKED";
export type Connection = "ONLINE" | "SUSPECT" | "OFFLINE";

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  connection: Connection;
  lastSeenAt: string | null;
  agentVersion: string | null;
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
  scenarioVersion: string;
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

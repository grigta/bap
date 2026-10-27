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
  payload: z.object({ agentVersion: z.string(), platform: z.string(), architecture: z.string() }),
});

export const agentCapabilities = z.object({
  ...event,
  type: z.literal("agent.capabilities"),
  payload: z.object({ providers: z.array(z.string()), maxSessions: z.number().int().nonnegative() }),
});

export const heartbeatPayload = z.object({
  cpuPercent: z.number().min(0).max(100),
  memoryPercent: z.number().min(0).max(100),
  lsAvailable: z.boolean(),
  activeSessions: z.number().int().nonnegative(),
});
export type HeartbeatPayload = z.infer<typeof heartbeatPayload>;

export const agentHeartbeat = z.object({ ...event, type: z.literal("agent.heartbeat"), payload: heartbeatPayload });

export const agentMessage = z.discriminatedUnion("type", [agentHello, agentCapabilities, agentHeartbeat]);
export type AgentMessage = z.infer<typeof agentMessage>;
export type AgentEvent = Exclude<AgentMessage, z.infer<typeof agentHello>>;

export const serverWelcome = z.object({
  ...envelope,
  type: z.literal("server.welcome"),
  payload: z.object({ agentId: z.uuid(), epoch: z.number().int().positive(), heartbeatIntervalMs: z.number().int().positive() }),
});
export const serverAck = z.object({ ...envelope, type: z.literal("server.ack"), payload: z.object({ id: z.uuid(), duplicate: z.boolean() }) });
export const serverError = z.object({ ...envelope, type: z.literal("server.error"), payload: z.object({ code: z.string(), message: z.string() }) });

export const serverMessage = z.discriminatedUnion("type", [serverWelcome, serverAck, serverError]);
export type ServerMessage = z.infer<typeof serverMessage>;

/** Builds a message with a fresh envelope. */
export function message<T extends { type: string; payload: unknown }>(body: T): T & { v: typeof PROTOCOL_VERSION; id: string; ts: string } {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: new Date().toISOString(), ...body };
}

export const AGENT_SOCKET_PATH = "/api/v1/agents/connect";

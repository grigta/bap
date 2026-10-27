import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

/** Error body shared by all endpoints. */
export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
});

export function sendError(reply: FastifyReply, request: FastifyRequest, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message, requestId: request.id } });
}

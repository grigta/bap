import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "@bap/database";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App } from "./app.ts";
import { sendError } from "./errors.ts";

/** Where the providers live and the keys for them; keys exist only on the server (ADR-0035). */
export interface ProvidersConfig {
  gotsms: { url: string; key: string | null };
  rucaptcha: { url: string; key: string | null };
  /** `api-anything` with the Spokeo spec and session in `home` (its ~/.api-anything). */
  spokeo: { bin: string; home: string } | null;
}
export const DEFAULT_PROVIDERS: ProvidersConfig = {
  gotsms: { url: "https://app.gotsms.org", key: null },
  rucaptcha: { url: "https://rucaptcha.com", key: null },
  spokeo: null,
};

/** A run token lives as long as its row runs, and this long at most. */
const TOKEN_TTL_MS = 2 * 60 * 60_000;
/** A fresh token is good before the heartbeat shows its run: the engine may call within seconds. */
const TOKEN_GRACE_MS = 60_000;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Issued when the server starts a row on a Mac; the engine calls the providers with it. */
export async function issueRunToken(db: Db, agentId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.insertInto("lsclicker_tokens").values({ token_hash: hash(token), agent_id: agentId, expires_at: new Date(Date.now() + TOKEN_TTL_MS) }).execute();
  return token;
}

/**
 * LS Clicker's providers through the server (ADR-0035): GotSMS (numbers, OTP), RuCaptcha (captcha)
 * and Spokeo (number lookup) are called with the server's keys. A Mac holds no key; its engine has a run
 * token that works only while that Mac runs a row. Bodies are passed on, never logged or journalled.
 */
export function registerProviders(app: App, { db, config }: { db: Db; config: ProvidersConfig }) {
  const runToken = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1];
    const row = token
      ? await db
          .selectFrom("lsclicker_tokens")
          .innerJoin("agents", "agents.id", "lsclicker_tokens.agent_id")
          .select(["lsclicker_tokens.agent_id", "lsclicker_tokens.created_at", "agents.last_heartbeat", "agents.status"])
          .where("token_hash", "=", hash(token))
          .where("expires_at", ">", new Date())
          .executeTakeFirst()
      : undefined;
    const running = (row?.last_heartbeat as { lsClicker?: { run?: { running?: boolean } } } | null)?.lsClicker?.run?.running === true;
    const fresh = !!row && Date.now() - row.created_at.getTime() < TOKEN_GRACE_MS;
    if (!row || row.status === "REVOKED" || !(running || fresh)) return sendError(reply, request, 401, "UNAUTHORIZED", "A valid run token is required");
    // Marks the call as the agent's: agent calls are not operator actions and stay out of the journal.
    request.agentId = row.agent_id;
  };
  const notConfigured = (request: FastifyRequest, reply: FastifyReply, name: string) => sendError(reply, request, 503, "PROVIDER_NOT_CONFIGURED", `${name} is not configured on the server`);
  const passOn = async (reply: FastifyReply, res: Response) =>
    reply
      .code(res.status)
      .header("content-type", res.headers.get("content-type") ?? "application/json")
      .send(Buffer.from(await res.arrayBuffer()));

  // GotSMS as it is, under another base address: only the key is the server's.
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/api/v1/providers/gotsms/*",
    preHandler: runToken,
    handler: async (request, reply) => {
      if (!config.gotsms.key) return notConfigured(request, reply, "GotSMS");
      const path = (request.params as { "*": string })["*"];
      const query = request.url.includes("?") ? request.url.slice(request.url.indexOf("?")) : "";
      const res = await fetch(`${config.gotsms.url}/${path}${query}`, {
        method: request.method,
        headers: { authorization: `Bearer ${config.gotsms.key}`, accept: "application/json", "user-agent": "ls-engine/1.0", ...(request.body !== undefined && { "content-type": "application/json" }) },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(120_000),
      });
      return passOn(reply, res);
    },
  });

  // RuCaptcha: in.php / res.php with the engine's parameters and the server's key.
  app.get(
    "/api/v1/providers/rucaptcha/:file",
    { preHandler: runToken, schema: { params: z.object({ file: z.enum(["in.php", "res.php"]) }), querystring: z.record(z.string(), z.string()) } },
    async (request, reply) => {
      if (!config.rucaptcha.key) return notConfigured(request, reply, "RuCaptcha");
      const query = new URLSearchParams(request.query);
      query.set("key", config.rucaptcha.key);
      const res = await fetch(`${config.rucaptcha.url}/${request.params.file}?${query}`, { signal: AbortSignal.timeout(60_000) });
      return passOn(reply, res);
    },
  );

  // Spokeo: api-anything runs here, with the session that used to sit on every Mac.
  app.post(
    "/api/v1/providers/spokeo/phone-lookup",
    { preHandler: runToken, schema: { body: z.object({ phone: z.string().regex(/^[0-9+\-() ]{7,20}$/, "a phone number") }) } },
    async (request, reply) => {
      if (!config.spokeo) return notConfigured(request, reply, "Spokeo");
      const { stdout } = await promisify(execFile)(config.spokeo.bin, ["call", "spokeo", "phoneLookup", `phone=${request.body.phone}`], {
        env: { ...process.env, HOME: config.spokeo.home },
        timeout: 90_000,
      }).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
      const line = stdout.split("\n").find((l) => l.includes('"ok"'));
      if (!line) return sendError(reply, request, 502, "SPOKEO_NO_ANSWER", "api-anything returned no answer");
      return reply.header("content-type", "application/json").send(line);
    },
  );
}

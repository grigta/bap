import { randomUUID } from "node:crypto";
import { createDb } from "@bap/database";
import { serverMessage } from "@bap/protocol";
import { afterAll, expect, test } from "vitest";
import { z } from "zod";
import { buildApp } from "../../apps/control-plane/src/app.ts";
import { memoryStore } from "../../apps/control-plane/src/storage.ts";

const app = buildApp({ db: createDb("postgres://unused@127.0.0.1/unused"), store: memoryStore() });
afterAll(() => app.close());

const envelope = () => ({ v: 1, id: randomUUID(), ts: new Date().toISOString() });

/** Every property name anywhere in a JSON schema. */
function propertyNames(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const own = Object.keys((schema as { properties?: object }).properties ?? {});
  return [...own, ...Object.values(schema).flatMap(propertyNames)];
}

test("[REQ-SEC-003] the agent accepts only the known server messages and request methods", () => {
  expect(serverMessage.safeParse({ ...envelope(), type: "server.request", payload: { method: "shell.exec", command: "rm -rf ~" } }).success).toBe(false);
  expect(serverMessage.safeParse({ ...envelope(), type: "agent.exec", payload: { script: "process.exit()" } }).success).toBe(false);
  // Code smuggled into a run assignment is dropped: the agent runs only the registered bundle with the sha256.
  const assign = serverMessage.parse({
    ...envelope(),
    type: "run.assign",
    payload: { runId: randomUUID(), scenario: { id: "s", version: "1.0.0", sha256: "a".repeat(64), code: "evil()" }, profileExternalId: "p", input: {}, timeoutMs: 1000, script: "evil()" },
  });
  expect(JSON.stringify(assign)).not.toContain("evil()");
});

test("[REQ-SEC-003] no API route takes code, scripts or shell commands", async () => {
  await app.ready();
  const fields = app.registeredRoutes.flatMap((r) => (r.schema?.body instanceof z.ZodType ? propertyNames(z.toJSONSchema(r.schema.body as z.ZodType)) : []));
  expect(fields.length).toBeGreaterThan(5);
  expect(fields.filter((f) => /^(code|script|source|command|cmd|shell|eval|exec|js)$/i.test(f))).toEqual([]);
});

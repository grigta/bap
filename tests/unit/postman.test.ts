import { createDb } from "@bap/database";
import { afterAll, expect, test } from "vitest";
import { buildApp } from "../../apps/control-plane/src/app.ts";
import { POSTMAN_SCHEMA, buildPostmanCollection } from "../../apps/control-plane/src/postman.ts";

const app = buildApp({ db: createDb("postgres://unused@127.0.0.1/unused") });
afterAll(() => app.close());

test("[REQ-API-001] Postman collection v2.1 describes every /api/v1 route", async () => {
  const collection = await buildPostmanCollection(app);
  expect(collection.info.schema).toBe(POSTMAN_SCHEMA);

  const described = collection.item.flatMap((folder) => folder.item.map((i) => i.name)).sort();
  const registered = app.registeredRoutes.filter((r) => r.url.startsWith("/api/v1/") && !r.websocket).map((r) => `${r.method} ${r.url}`).sort();
  expect(registered.length).toBeGreaterThan(0);
  expect(described).toEqual(registered);
});

test("[REQ-API-001] protected requests carry the bearer token and bodies use variables", async () => {
  const collection = await buildPostmanCollection(app);
  const items = collection.item.flatMap((f) => f.item);
  const login = items.find((i) => i.name === "POST /api/v1/auth/login")!;
  expect(JSON.parse(login.request.body!.raw)).toEqual({ login: "{{login}}", password: "{{password}}" });
  expect(login.request.header).not.toContainEqual({ key: "Authorization", value: "Bearer {{token}}" });

  const agents = items.find((i) => i.name === "GET /api/v1/agents")!;
  expect(agents.request.header).toContainEqual({ key: "Authorization", value: "Bearer {{token}}" });
  expect(agents.request.url.raw).toBe("{{baseUrl}}/api/v1/agents");
  expect(collection.variable.map((v) => v.key)).toEqual(expect.arrayContaining(["baseUrl", "token", "login", "password", "name"]));
});

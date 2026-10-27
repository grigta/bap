import { z } from "zod";
import type { App } from "./app.ts";

/** Postman Collection v2.1 generated from route schemas. */
export interface PostmanCollection {
  info: { name: string; schema: string };
  variable: { key: string; value: string }[];
  item: { name: string; item: PostmanRequestItem[] }[];
}

interface PostmanRequestItem {
  name: string;
  request: {
    method: string;
    header: { key: string; value: string }[];
    url: { raw: string; host: string[]; path: string[] };
    body?: { mode: "raw"; raw: string; options: { raw: { language: "json" } } };
  };
}

export const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

export async function buildPostmanCollection(app: App): Promise<PostmanCollection> {
  await app.ready();
  const variables = new Set(["baseUrl", "token"]);
  const folders = new Map<string, PostmanRequestItem[]>();

  for (const route of app.registeredRoutes.filter((r) => r.url.startsWith("/api/v1/"))) {
    const path = route.url.split("/").filter(Boolean);
    const header = [{ key: "Content-Type", value: "application/json" }];
    if (route.auth) header.push({ key: "Authorization", value: "Bearer {{token}}" });
    const item: PostmanRequestItem = {
      name: `${route.method} ${route.url}`,
      request: { method: route.method, header, url: { raw: `{{baseUrl}}${route.url}`, host: ["{{baseUrl}}"], path } },
    };
    const body = route.schema?.body;
    if (body instanceof z.ZodType) {
      item.request.body = { mode: "raw", raw: JSON.stringify(example(z.toJSONSchema(body) as JsonSchema, variables), null, 2), options: { raw: { language: "json" } } };
    }
    const folder = path[2] ?? "root";
    folders.set(folder, [...(folders.get(folder) ?? []), item]);
  }

  return {
    info: { name: "BAP API", schema: POSTMAN_SCHEMA },
    variable: [...variables].map((key) => ({ key, value: key === "baseUrl" ? "http://127.0.0.1:3000" : "" })),
    item: [...folders].map(([name, item]) => ({ name, item })),
  };
}

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema };

/** Example body: string fields become collection variables so requests run as-is with an environment. */
function example(schema: JsonSchema, variables: Set<string>, key = "value"): unknown {
  switch (schema.type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, s]) => [k, example(s, variables, k)]));
    case "array":
      return schema.items ? [example(schema.items, variables, key)] : [];
    case "string":
      variables.add(key);
      return `{{${key}}}`;
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

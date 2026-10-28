import { afterAll, beforeAll, expect, test } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import pg from "pg";
import * as Minio from "minio";
import { s3Store } from "../../apps/control-plane/src/storage.ts";

let postgres: StartedPostgreSqlContainer;
let s3: StartedTestContainer;

beforeAll(async () => {
  [postgres, s3] = await Promise.all([
    new PostgreSqlContainer("postgres:17-alpine").start(),
    new GenericContainer("chrislusf/seaweedfs:4.50")
      .withCommand(["server", "-s3", "-dir=/data"])
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forHttp("/", 8333).forStatusCode(200))
      .start(),
  ]);
});

afterAll(async () => {
  await Promise.all([postgres?.stop(), s3?.stop()]);
});

test("PostgreSQL container generates UUIDs", async () => {
  const client = new pg.Client({ connectionString: postgres.getConnectionUri() });
  await client.connect();
  const { rows } = await client.query("SELECT gen_random_uuid() AS id");
  await client.end();
  expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
});

test("S3 container stores and returns an object", async () => {
  const client = new Minio.Client({
    endPoint: s3.getHost(),
    port: s3.getMappedPort(8333),
    useSSL: false,
    accessKey: "test",
    secretKey: "test",
  });
  await client.makeBucket("artifacts");
  await client.putObject("artifacts", "hello.txt", Buffer.from("bap"));
  const stream = await client.getObject("artifacts", "hello.txt");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe("bap");
});

test("the Control Plane S3 store creates its bucket, stores objects and reports missing ones", async () => {
  const opts = { endpoint: `http://${s3.getHost()}:${s3.getMappedPort(8333)}`, bucket: "bap-artifacts", accessKeyId: "test", secretAccessKey: "test" };
  const store = await s3Store(opts);
  await store.put("runs/r1/01-step.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
  expect(await store.get("runs/r1/01-step.png")).toEqual({ body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" });
  expect(await store.get("runs/r1/missing.png")).toBeNull();
  // Opening the store again finds the existing bucket instead of failing.
  expect(await (await s3Store(opts)).get("runs/r1/01-step.png")).not.toBeNull();
});

import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { assertLoopbackOnly, lsofListeners } from "@bap/browser-adapters";
import { expect, test } from "vitest";

const hasLsof = spawnSync("which", ["lsof"]).status === 0;

test("[REQ-SEC-002] a port that starts listening a moment later is checked once it listens", async () => {
  let calls = 0;
  await assertLoopbackOnly(9222, "CDP", () => (++calls < 3 ? [] : ["127.0.0.1"]), 2000);
  expect(calls).toBe(3);
});

test("[REQ-SEC-002] a port nobody listens on cannot be verified and is refused", async () => {
  await expect(assertLoopbackOnly(9222, "CDP", () => [], 200)).rejects.toThrow(/no listener found/);
});

test.skipIf(!hasLsof)("[REQ-SEC-002] lsof sees a real listener and its address", async () => {
  const local = createServer().listen(0, "127.0.0.1");
  const wide = createServer().listen(0, "0.0.0.0");
  await Promise.all([local, wide].map((s) => new Promise((r) => s.once("listening", r))));
  try {
    const port = (s: typeof local) => (s.address() as { port: number }).port;
    expect(lsofListeners(port(local))).toEqual(["127.0.0.1"]);
    expect(lsofListeners(port(wide))).toEqual(["*"]);
    await expect(assertLoopbackOnly(port(wide), "test server")).rejects.toThrow(/listens on \*/);
  } finally {
    local.close();
    wide.close();
  }
});

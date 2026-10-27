import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

const freePort = () =>
  new Promise<number>((done) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });

/** Starts tests/fixtures/test-site on a free port. */
export async function startTestSite(): Promise<{ url: string; stop: () => Promise<void> }> {
  const port = await freePort();
  const proc: ChildProcess = spawn("node", [resolve(import.meta.dirname, "../fixtures/test-site/server.ts")], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((ready, fail) => {
    proc.stdout!.once("data", () => ready());
    proc.once("exit", (code) => fail(new Error(`test site exited with ${code}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      proc.kill();
    },
  };
}

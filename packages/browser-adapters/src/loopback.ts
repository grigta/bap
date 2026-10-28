import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** Local addresses a TCP port listens on, e.g. ["127.0.0.1"] or ["*"] for all interfaces. */
export type ListenerLookup = (port: number) => string[];

/** Parses `lsof -Fn` output: lines "n127.0.0.1:41234", "n*:9222", "n[::1]:9222". */
export function parseLsofListeners(output: string): string[] {
  return [...new Set(output.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1, l.lastIndexOf(":"))))];
}

export const lsofListeners: ListenerLookup = (port) =>
  parseLsofListeners(spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" }).stdout ?? "");

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
export const isLoopbackHost = (host: string) => LOOPBACK.has(host);

/**
 * Fails unless the port listens, and only on loopback (REQ-SEC-002): the Local API has no auth and
 * CDP gives full control of the browser, so either one reachable from the network is a breach.
 */
export async function assertLoopbackOnly(port: number, what: string, lookup: ListenerLookup = lsofListeners, waitMs = 5000): Promise<void> {
  let addresses = lookup(port);
  for (const started = Date.now(); addresses.length === 0 && Date.now() - started < waitMs; addresses = lookup(port)) await sleep(100);
  if (addresses.length === 0) throw new Error(`${what} on port ${port}: no listener found, cannot verify it is local-only`);
  const exposed = addresses.filter((a) => !isLoopbackHost(a));
  if (exposed.length > 0) throw new Error(`${what} on port ${port} listens on ${exposed.join(", ")}: it must listen on 127.0.0.1 only`);
}

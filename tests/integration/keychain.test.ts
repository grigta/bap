import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createTestKeychain, keychainStore } from "../../apps/mac-agent/src/secret-store.ts";

// The real macOS Keychain, on a throwaway keychain file; CI runs on Linux.
const path = process.platform === "darwin" ? join(mkdtempSync(join(tmpdir(), "bap-keychain-")), "test.keychain-db") : "";
afterAll(() => {
  if (path) execFileSync("security", ["delete-keychain", path]);
});

test.skipIf(process.platform !== "darwin")("[REQ-SEC-007] secrets round-trip through the macOS Keychain without appearing on a command line", () => {
  createTestKeychain(path);
  const store = keychainStore(path);
  expect(store.get("bap-agent", "agent-1")).toBeNull();
  const secret = 'k3y with spaces, "quotes" and \\\\ backslashes';
  store.set("bap-agent", "agent-1", secret);
  expect(store.get("bap-agent", "agent-1")).toBe(secret);
  store.set("bap-agent", "agent-1", "rotated");
  expect(store.get("bap-agent", "agent-1")).toBe("rotated");
  expect(() => store.set("bap agent", "agent-1", "x")).toThrow(/unsupported characters/);
});

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkenSphereProvider } from "@bap/browser-adapters";
import { afterAll, describe, expect, test } from "vitest";
import { browserProviderContract } from "../support/browser-provider-contract.ts";
import { startFakeLinkenSphere } from "../support/fake-linken-sphere.ts";

const sessionsDir = mkdtempSync(join(tmpdir(), "bap-fake-ls-"));
const ls = await startFakeLinkenSphere(sessionsDir);
const provider = new LinkenSphereProvider({ apiUrl: ls.url, headless: true });
afterAll(() => ls.stop());

// The emulator stands in for Linken Sphere in fault tests; it must keep the same contract.
describe("fake Linken Sphere behind the real provider", () => {
  browserProviderContract({
    name: "fake-linken-sphere",
    tags: { contract: "[REQ-LS-001]", cdp: "[REQ-LS-001]", detach: "[REQ-LS-001]", persistence: "[REQ-LS-001]" },
    provider,
    createProfile: async () => provider.api.createSession(`fake-${Date.now()}`),
    deleteProfile: async (uuid) => {
      await provider.api.stop(uuid).catch(() => {});
      await provider.api.deleteSession(uuid);
    },
    isRunning: async (uuid) => execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8" }).includes(join(sessionsDir, uuid)),
  });

  test("[REQ-LS-006] a Local API that stops answering is reported unavailable, and available again when it is back", async () => {
    expect(await provider.isAvailable()).toBe(true);
    await ls.down();
    expect(await provider.isAvailable()).toBe(false);
    await ls.up();
    expect(await provider.isAvailable()).toBe(true);
  });
});

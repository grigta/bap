import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { LocalChromiumProvider } from "@bap/browser-adapters";
import { browserProviderContract } from "../support/browser-provider-contract.ts";

const profilesDir = mkdtempSync(join(tmpdir(), "bap-profiles-"));
const provider = new LocalChromiumProvider({ profilesDir });

describe("local-chromium provider", () => {
  browserProviderContract({
    name: "local-chromium",
    // Only the shared contract is claimed here; Linken Sphere requirements need the real provider.
    tags: { contract: "[REQ-LS-001]", cdp: "[REQ-LS-001]", detach: "[REQ-LS-001]", persistence: "[REQ-LS-001]" },
    provider,
    createProfile: async () => {
      const id = randomUUID();
      provider.createProfile(id);
      return id;
    },
    deleteProfile: async () => rmSync(profilesDir, { recursive: true, force: true }),
    isRunning: async (id) => execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8" }).includes(join(profilesDir, id)),
  });
});

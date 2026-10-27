// Runs only locally (`pnpm test:ls`): needs Linken Sphere 2 running, signed in, with the Local API enabled.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { LinkenSphereProvider } from "@bap/browser-adapters";
import { browserProviderContract } from "../support/browser-provider-contract.ts";
import { pageEvidence } from "../support/evidence.ts";

const apiUrl = process.env.BAP_LS_API_URL ?? "http://127.0.0.1:41234";
const provider = new LinkenSphereProvider({ apiUrl, headless: process.env.BAP_LS_HEADLESS === "true" });
const { api } = provider;

describe("linken-sphere provider", () => {
  browserProviderContract({
    name: "linken-sphere",
    tags: {
      contract: "[REQ-LS-001]",
      cdp: "[REQ-LS-001][REQ-LS-003]",
      detach: "[REQ-LS-001][REQ-LS-004]",
      persistence: "[REQ-LS-001][REQ-LS-005]",
    },
    provider,
    createProfile: () => api.createSession(`bap-test-${Date.now()}`),
    deleteProfile: async (uuid) => {
      await api.stop(uuid).catch(() => {});
      await api.deleteSession(uuid);
    },
    isRunning: async (uuid) => (await api.listSessions()).find((s) => s.uuid === uuid)?.status !== "stopped",
    onPage: (name, page) => pageEvidence(page, "S1", `ls-${name}`),
  });

  test("[REQ-LS-002] the installed Linken Sphere version is in the documented compatibility matrix", () => {
    const version = execFileSync("defaults", ["read", "/Applications/Linken Sphere 2.app/Contents/Info", "CFBundleShortVersionString"], {
      encoding: "utf8",
    }).trim();
    const doc = readFileSync(resolve(import.meta.dirname, "../../docs/linken-sphere-api.md"), "utf8");
    expect(doc).toMatch(new RegExp(`^\\| ${version.replace(/\./g, "\\.")} \\|.*\\| OK \\|$`, "m"));
  });
});

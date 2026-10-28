import { afterAll, beforeAll, expect, test } from "vitest";
import { type BrowserProvider, ProfileNotFoundError } from "@bap/browser-adapters";
import type { Page } from "playwright-core";
import { startTestSite } from "./test-site.ts";

export interface ContractTarget {
  name: string;
  /** Requirement tags this provider's run proves, e.g. "[REQ-LS-001]". */
  tags: { contract: string; cdp: string; detach: string; persistence: string };
  provider: BrowserProvider;
  createProfile(): Promise<string>;
  deleteProfile(id: string): Promise<void>;
  isRunning(id: string): Promise<boolean>;
  /** Called with notable pages so a suite can save gate evidence. */
  onPage?(name: string, page: Page): Promise<void>;
}

/** Behaviour every BrowserProvider must have; run against each implementation. */
export function browserProviderContract(target: ContractTarget) {
  let site: Awaited<ReturnType<typeof startTestSite>>;
  let profileId: string;
  const visits = async (session: Awaited<ReturnType<BrowserProvider["openSession"]>>) => {
    const page = await session.getPage();
    await page.goto(site.url);
    return Number(await page.locator("#visits").textContent());
  };

  beforeAll(async () => {
    site = await startTestSite();
    profileId = await target.createProfile();
  });
  afterAll(async () => {
    await target.deleteProfile(profileId);
    await site.stop();
  });

  test(`${target.tags.contract} ${target.name}: is available, lists the profile and rejects unknown profiles`, async () => {
    expect(await target.provider.isAvailable()).toBe(true);
    const listed = await target.provider.listProfiles();
    expect(listed).toContainEqual({ id: profileId, name: expect.any(String) });
    for (const p of listed) expect(Object.keys(p).sort()).toEqual(["id", "name"]);
    await expect(target.provider.openSession("00000000-0000-0000-0000-000000000000", "run-x")).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  test(`${target.tags.cdp} ${target.name}: attach connects Playwright over CDP and drives the test site`, async () => {
    const session = await target.provider.openSession(profileId, "run-1");
    await session.attach();
    expect(await visits(session)).toBeGreaterThanOrEqual(1);
    expect(await session.inspect()).toEqual({ connected: true, currentUrl: `${site.url}/` });
    await session.closeSession();
  });

  test(`${target.tags.detach} ${target.name}: detach keeps the browser running, closeSession stops it and keeps the profile`, async () => {
    const session = await target.provider.openSession(profileId, "run-2");
    await session.attach();
    await visits(session);
    await session.detach();
    expect(await session.inspect()).toEqual({ connected: false });
    expect(await target.isRunning(profileId)).toBe(true);

    await session.attach();
    expect((await session.inspect()).connected).toBe(true);
    expect(await target.provider.profileState(profileId)).toBe("busy");
    await session.closeSession();
    expect(await target.isRunning(profileId)).toBe(false);
    expect(await target.provider.profileState(profileId)).toBe("idle");
    expect(await target.provider.profileState("00000000-0000-0000-0000-000000000000")).toBe("missing");
    await expect(target.provider.openSession(profileId, "run-3")).resolves.toBeDefined();
  });

  test(`${target.tags.persistence} ${target.name}: storage and cookies persist across sessions`, async () => {
    const first = await target.provider.openSession(profileId, "run-4");
    await first.attach();
    const before = await visits(first);
    await target.onPage?.("first-session", await first.getPage());
    await first.closeSession();

    const second = await target.provider.openSession(profileId, "run-5");
    await second.attach();
    const after = await visits(second);
    const page = await second.getPage();
    const cookie = (await page.context().cookies()).find((c) => c.name === "visits");
    await target.onPage?.("second-session", page);
    await second.closeSession();

    expect(after).toBeGreaterThan(before);
    expect(Number(cookie?.value)).toBe(after);
  });
}

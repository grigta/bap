import type { Page } from "playwright-core";

/**
 * A browser session for one run on one persistent profile.
 *
 * Guarantees:
 * - `detach()` only disconnects Playwright: the browser keeps running and the profile is untouched.
 * - `closeSession()` stops the browser; the profile and its state (cookies, storage) are kept.
 */
export interface BrowserSession {
  readonly profileId: string;
  readonly runId: string;
  attach(): Promise<void>;
  getPage(): Promise<Page>;
  inspect(): Promise<{ connected: boolean; currentUrl?: string }>;
  detach(): Promise<void>;
  closeSession(): Promise<void>;
}

/** What a provider reveals about a stored profile: no cookies, storage or credentials. */
export interface ProfileSummary {
  id: string;
  name: string;
}

export type ProfileState = "idle" | "busy" | "missing";

export interface BrowserProvider {
  isAvailable(): Promise<boolean>;
  listProfiles(): Promise<ProfileSummary[]>;
  /** Whether the profile exists and no browser holds it: what VERIFYING checks after a run. */
  profileState(profileId: string): Promise<ProfileState>;
  openSession(profileId: string, runId: string): Promise<BrowserSession>;
}

export class ProfileNotFoundError extends Error {
  readonly profileId: string;
  constructor(profileId: string) {
    super(`browser profile ${profileId} not found`);
    this.profileId = profileId;
  }
}

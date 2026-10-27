import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type Page, chromium } from "playwright-core";
import type { BrowserSession } from "./types.ts";

/** Shared Playwright side of a session: everything after the provider has a CDP port. */
export abstract class CdpSession implements BrowserSession {
  readonly profileId: string;
  readonly runId: string;
  private browser: Browser | null = null;
  /** Known while the browser runs: LS rejects a second start (409) and does not report the port. */
  private port: number | null = null;
  private page: Page | null = null;

  constructor(profileId: string, runId: string) {
    this.profileId = profileId;
    this.runId = runId;
  }

  /** Starts the browser and returns its CDP port. */
  protected abstract start(): Promise<number>;
  /** Stops the browser process; the profile must survive. */
  protected abstract stop(): Promise<void>;

  async attach(): Promise<void> {
    if (this.browser?.isConnected()) return;
    this.port ??= await this.start();
    await waitForCdp(this.port);
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.port}`);
  }

  async getPage(): Promise<Page> {
    if (!this.browser?.isConnected()) throw new Error(`session ${this.profileId} is not attached`);
    if (!this.page || this.page.isClosed()) this.page = await this.browser.contexts()[0]!.newPage();
    return this.page;
  }

  async inspect(): Promise<{ connected: boolean; currentUrl?: string }> {
    const connected = this.browser?.isConnected() ?? false;
    return connected && this.page && !this.page.isClosed() ? { connected, currentUrl: this.page.url() } : { connected };
  }

  async detach(): Promise<void> {
    // For a CDP connection, close() disconnects Playwright and leaves the browser running.
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }

  async closeSession(): Promise<void> {
    await this.detach();
    await this.stop();
    this.port = null;
  }
}

/** Linken Sphere reports the port before Chromium listens on it. */
async function waitForCdp(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`CDP port ${port} did not open within ${timeoutMs} ms`);
    await sleep(200);
  }
}

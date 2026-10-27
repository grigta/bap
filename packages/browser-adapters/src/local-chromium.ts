import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CdpSession } from "./cdp-session.ts";
import { type BrowserProvider, ProfileNotFoundError, type ProfileSummary } from "./types.ts";

/**
 * Plain Chromium with one user-data-dir per profile. Runs as a separate process with a CDP port,
 * so detach/closeSession behave like Linken Sphere. Used in CI, where Linken Sphere is unavailable.
 */
export class LocalChromiumProvider implements BrowserProvider {
  private readonly profilesDir: string;
  private readonly headless: boolean;

  constructor({ profilesDir, headless = true }: { profilesDir: string; headless?: boolean }) {
    this.profilesDir = profilesDir;
    this.headless = headless;
  }

  createProfile(profileId: string): void {
    mkdirSync(join(this.profilesDir, profileId), { recursive: true });
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(chromium.executablePath());
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    if (!existsSync(this.profilesDir)) return [];
    return readdirSync(this.profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ id: d.name, name: d.name }));
  }

  async openSession(profileId: string, runId: string): Promise<LocalChromiumSession> {
    const dir = join(this.profilesDir, profileId);
    if (!existsSync(dir)) throw new ProfileNotFoundError(profileId);
    return new LocalChromiumSession(dir, profileId, runId, this.headless);
  }
}

class LocalChromiumSession extends CdpSession {
  private readonly userDataDir: string;
  private readonly headless: boolean;
  private process: ChildProcess | null = null;
  private cdpPort = 0;

  constructor(userDataDir: string, profileId: string, runId: string, headless: boolean) {
    super(profileId, runId);
    this.userDataDir = userDataDir;
    this.headless = headless;
  }

  protected async start(): Promise<number> {
    const portFile = join(this.userDataDir, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    const args = [`--user-data-dir=${this.userDataDir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check"];
    if (this.headless) args.push("--headless=new");
    // Ubuntu 24.04 blocks the unprivileged user namespaces the sandbox needs; Playwright does the same.
    if (process.platform === "linux") args.push("--no-sandbox");
    const proc = spawn(chromium.executablePath(), [...args, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr!.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
    this.process = proc;
    for (let i = 0; i < 300; i++) {
      // Chromium creates the file before writing it: an empty read is not a port.
      const port = existsSync(portFile) ? Number(readFileSync(portFile, "utf8").split("\n")[0]) : 0;
      if (port > 0) return (this.cdpPort = port);
      if (proc.exitCode !== null) break;
      await sleep(100);
    }
    throw new Error(`Chromium for profile ${this.profileId} did not open a CDP port:\n${stderr}`);
  }

  protected async stop(): Promise<void> {
    const proc = this.process;
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((resolve) => proc.once("exit", resolve));
    // Browser.close lets Chromium flush cookies and localStorage; a signal would lose them.
    // If the graceful path fails or hangs, the process is killed after 5 s.
    const graceful = (async () => {
      if (this.cdpPort <= 0) throw new Error("no CDP port");
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`);
      await (await browser.newBrowserCDPSession()).send("Browser.close").catch(() => {});
      await exited;
    })();
    const timeout = sleep(5000).then(() => "timeout" as const);
    if ((await Promise.race([graceful.catch(() => "failed" as const), timeout])) !== undefined) {
      proc.kill("SIGKILL");
      await exited;
    }
    this.process = null;
    this.cdpPort = 0;
  }
}

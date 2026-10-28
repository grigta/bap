import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";
import { CdpSession } from "./cdp-session.ts";
import { type BrowserProvider, ProfileNotFoundError, type ProfileState, type ProfileSummary } from "./types.ts";

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

  async profileState(profileId: string): Promise<ProfileState> {
    const dir = join(this.profilesDir, profileId);
    if (!existsSync(dir)) return "missing";
    // A Chromium process started for this profile carries its user-data-dir on the command line.
    const processes = execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8" });
    return processes.includes(`--user-data-dir=${dir}`) ? "busy" : "idle";
  }

  async forceRelease(profileId: string): Promise<void> {
    const dir = join(this.profilesDir, profileId);
    const lines = execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" }).split("\n");
    for (const line of lines) {
      const [pid, ...command] = line.trim().split(" ");
      if (command.join(" ").includes(`--user-data-dir=${dir}`)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    for (let i = 0; i < 50 && (await this.profileState(profileId)) === "busy"; i++) await sleep(100);
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
  private launched: LaunchedChromium | null = null;

  constructor(userDataDir: string, profileId: string, runId: string, headless: boolean) {
    super(profileId, runId);
    this.userDataDir = userDataDir;
    this.headless = headless;
  }

  protected async start(): Promise<number> {
    this.launched = await launchChromium(this.userDataDir, this.headless);
    return this.launched.port;
  }

  protected async stop(): Promise<void> {
    if (this.launched) await closeChromium(this.launched);
    this.launched = null;
  }
}

export interface LaunchedChromium {
  process: ChildProcess;
  port: number;
}

/** Starts Chromium on a user-data-dir with a CDP port chosen by Chromium itself. */
export async function launchChromium(userDataDir: string, headless: boolean): Promise<LaunchedChromium> {
  disablePasswordManager(userDataDir);
  const portFile = join(userDataDir, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const args = [`--user-data-dir=${userDataDir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check"];
  if (headless) args.push("--headless=new");
  // Ubuntu 24.04 blocks the unprivileged user namespaces the sandbox needs; Playwright does the same.
  if (process.platform === "linux") args.push("--no-sandbox");
  const proc = spawn(chromium.executablePath(), [...args, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr!.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  for (let i = 0; i < 300; i++) {
    // Chromium creates the file before writing it: an empty read is not a port.
    const port = existsSync(portFile) ? Number(readFileSync(portFile, "utf8").split("\n")[0]) : 0;
    if (port > 0) return { process: proc, port };
    if (exited(proc)) break;
    await sleep(100);
  }
  throw new Error(`Chromium on ${userDataDir} did not open a CDP port:\n${stderr}`);
}

/**
 * Browser.close lets Chromium flush cookies and localStorage; a signal would lose them.
 * If the graceful path fails or hangs, the process is killed after 5 s.
 */
export async function closeChromium({ process: proc, port }: LaunchedChromium): Promise<void> {
  if (exited(proc)) return;
  const exit = new Promise((resolve) => proc.once("exit", resolve));
  const graceful = (async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    await (await browser.newBrowserCDPSession()).send("Browser.close").catch(() => {});
    await exit;
  })();
  const timeout = sleep(5000).then(() => "timeout" as const);
  if ((await Promise.race([graceful.catch(() => "failed" as const), timeout])) !== undefined) {
    proc.kill("SIGKILL");
    if (!exited(proc)) await exit;
  }
}

/**
 * After a login with a known leaked password, Chromium opens a "change your password" dialog that swallows
 * every click on the page (public demo sites use such passwords). The profile's password manager is turned off.
 */
function disablePasswordManager(userDataDir: string) {
  const file = join(userDataDir, "Default", "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    mkdirSync(dirname(file), { recursive: true });
  }
  const profile = (prefs.profile ?? {}) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...prefs, credentials_enable_service: false, profile: { ...profile, password_manager_enabled: false, password_manager_leak_detection: false } }));
}

/** A process killed by a signal has exitCode null and signalCode set. */
const exited = (proc: ChildProcess) => proc.exitCode !== null || proc.signalCode !== null;

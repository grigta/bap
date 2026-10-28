import { CdpSession } from "./cdp-session.ts";
import { type ListenerLookup, assertLoopbackOnly, isLoopbackHost, lsofListeners } from "./loopback.ts";
import { type BrowserProvider, ProfileNotFoundError, type ProfileState, type ProfileSummary } from "./types.ts";

/**
 * Linken Sphere 2 Local API (checked against 2.26.10). The API listens on 127.0.0.1 only,
 * has no auth, and requires the client to be running and signed in. Profiles are LS "sessions".
 */
export interface LinkenSphereOptions {
  apiUrl: string;
  headless?: boolean;
  timeoutMs?: number;
  /** Where ports listen; lsof by default (tests substitute it). */
  listeners?: ListenerLookup;
}

export interface LsSessionSummary {
  name: string;
  status: string;
  uuid: string;
}

export class LinkenSphereApi {
  private readonly apiUrl: string;
  private readonly timeoutMs: number;

  constructor({ apiUrl, timeoutMs = 60_000 }: LinkenSphereOptions) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async request<T>(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Linken Sphere ${method} ${path}: HTTP ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  listSessions = () => this.request<LsSessionSummary[]>("GET", "/sessions");
  createSession = async (name: string) => {
    const [created] = await this.request<{ uuid: string }[]>("POST", "/sessions/create_quick", { count: 1 });
    await this.request("POST", "/sessions/set_name", { uuid: created!.uuid, name });
    return created!.uuid;
  };
  start = (uuid: string, headless: boolean) => this.request<{ debug_port: number }>("POST", "/sessions/start", { uuid, headless });
  stop = (uuid: string) => this.request("POST", "/sessions/stop", { uuid });
  deleteSession = (uuid: string) => this.request("DELETE", "/sessions", { uuid });
  /** Signs the client in with autologin; the password comes from the agent's keychain, never from config files. */
  signIn = (email: string, password: string) => this.request<{ message: string }>("POST", "/auth/signin", { email, password, autologin: true });
}

export class LinkenSphereProvider implements BrowserProvider {
  readonly api: LinkenSphereApi;
  private readonly headless: boolean;
  private readonly apiPort: number;
  private readonly listeners: ListenerLookup;

  constructor(options: LinkenSphereOptions) {
    const url = new URL(options.apiUrl);
    if (!isLoopbackHost(url.hostname)) throw new Error(`Linken Sphere API ${options.apiUrl} must be on 127.0.0.1 (REQ-SEC-002)`);
    this.api = new LinkenSphereApi(options);
    this.headless = options.headless ?? false;
    this.apiPort = Number(url.port || 80);
    this.listeners = options.listeners ?? lsofListeners;
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Short timeout: this runs in every heartbeat.
      await this.api.request("GET", "/sessions", undefined, 3000);
      return true;
    } catch {
      return false;
    }
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    return (await this.api.listSessions()).map((s) => ({ id: s.uuid, name: s.name }));
  }

  async profileState(profileId: string): Promise<ProfileState> {
    const session = (await this.api.listSessions()).find((s) => s.uuid === profileId);
    return !session ? "missing" : session.status === "stopped" ? "idle" : "busy";
  }

  async forceRelease(profileId: string): Promise<void> {
    if ((await this.profileState(profileId)) === "busy") await this.api.request("POST", "/sessions/force_stop", { uuid: profileId });
  }

  async openSession(profileId: string, runId: string): Promise<LinkenSphereSession> {
    const known = await this.api.listSessions();
    if (!known.some((s) => s.uuid === profileId)) throw new ProfileNotFoundError(profileId);
    // LS settings can change while the agent runs, so the check repeats for every session.
    await assertLoopbackOnly(this.apiPort, "Linken Sphere Local API", this.listeners, 0);
    return new LinkenSphereSession(this.api, profileId, runId, this.headless, this.listeners);
  }
}

class LinkenSphereSession extends CdpSession {
  private readonly api: LinkenSphereApi;
  private readonly headless: boolean;
  private readonly listeners: ListenerLookup;

  constructor(api: LinkenSphereApi, profileId: string, runId: string, headless: boolean, listeners: ListenerLookup) {
    super(profileId, runId);
    this.api = api;
    this.headless = headless;
    this.listeners = listeners;
  }

  // LS may pick another debug port than requested; only the response is authoritative.
  protected async start(): Promise<number> {
    const port = (await this.api.start(this.profileId, this.headless)).debug_port;
    try {
      await assertLoopbackOnly(port, "CDP of the Linken Sphere session", this.listeners);
    } catch (e) {
      await this.api.stop(this.profileId).catch(() => {});
      throw e;
    }
    return port;
  }

  protected async stop(): Promise<void> {
    await this.api.stop(this.profileId);
  }
}

import { CdpSession } from "./cdp-session.ts";
import { type BrowserProvider, ProfileNotFoundError, type ProfileState, type ProfileSummary } from "./types.ts";

/**
 * Linken Sphere 2 Local API (checked against 2.26.10). The API listens on 127.0.0.1 only,
 * has no auth, and requires the client to be running and signed in. Profiles are LS "sessions".
 */
export interface LinkenSphereOptions {
  apiUrl: string;
  headless?: boolean;
  timeoutMs?: number;
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
}

export class LinkenSphereProvider implements BrowserProvider {
  readonly api: LinkenSphereApi;
  private readonly headless: boolean;

  constructor(options: LinkenSphereOptions) {
    this.api = new LinkenSphereApi(options);
    this.headless = options.headless ?? false;
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
    return new LinkenSphereSession(this.api, profileId, runId, this.headless);
  }
}

class LinkenSphereSession extends CdpSession {
  private readonly api: LinkenSphereApi;
  private readonly headless: boolean;

  constructor(api: LinkenSphereApi, profileId: string, runId: string, headless: boolean) {
    super(profileId, runId);
    this.api = api;
    this.headless = headless;
  }

  // LS may pick another debug port than requested; only the response is authoritative.
  protected async start(): Promise<number> {
    return (await this.api.start(this.profileId, this.headless)).debug_port;
  }

  protected async stop(): Promise<void> {
    await this.api.stop(this.profileId);
  }
}

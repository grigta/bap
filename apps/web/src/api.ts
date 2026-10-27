export class HttpError extends Error {
  readonly status: number;
  /** Stable error code from the API error body, when there is one. */
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(path: string, init?: RequestInit & { timeoutMs?: number; headers?: Record<string, string> }): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
    signal: AbortSignal.timeout(init?.timeoutMs ?? 10_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new HttpError(res.status, body?.error?.code ?? null, body?.error?.message ?? `HTTP ${res.status}`);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

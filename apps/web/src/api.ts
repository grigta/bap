export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    signal: AbortSignal.timeout(init?.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new HttpError(res.status);
  return (res.status === 204 ? null : await res.json()) as T;
}

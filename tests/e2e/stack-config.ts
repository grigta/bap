export const STACK_PORTS = { web: 5174, controlPlane: 3100, control: 3199 } as const;
export const E2E_OPERATOR = { login: "operator", password: "e2e-password" } as const;
/** Compressed heartbeat timings so SUSPECT/OFFLINE show up within a test. */
export const STACK_FLEET = { heartbeatIntervalMs: 1000, suspectAfterMs: 3000, offlineAfterMs: 6000 } as const;

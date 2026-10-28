import { execFileSync, spawnSync } from "node:child_process";

/** Where the agent keeps its secrets: the agent key and the Linken Sphere sign-in (REQ-SEC-007). */
export interface SecretStore {
  get(service: string, account: string): string | null;
  set(service: string, account: string, secret: string): void;
}

/** Arguments for `security -i` are space-separated; ours are identifiers and paths without spaces or quotes. */
const token = (s: string) => {
  if (!/^[\w@.\-/:+]+$/.test(s)) throw new Error(`unsupported characters in keychain argument: ${s}`);
  return s;
};

/**
 * macOS Keychain through the `security` tool. Secrets go to `security -i` on stdin, never on the
 * command line, where other processes could read them. `keychain` selects a keychain file (tests).
 */
export function keychainStore(keychain?: string): SecretStore {
  const target = keychain ? [keychain] : [];
  return {
    get(service, account) {
      const res = spawnSync("security", ["find-generic-password", "-s", service, "-a", account, "-w", ...target], { encoding: "utf8" });
      if (res.status !== 0) return null;
      return res.stdout.replace(/\n$/, "");
    },
    set(service, account, secret) {
      // Hex keeps any secret free of characters the `security -i` parser would interpret.
      const hex = Buffer.from(secret, "utf8").toString("hex");
      const command = ["add-generic-password", "-U", "-s", token(service), "-a", token(account), "-X", hex, ...target.map(token)].join(" ");
      const res = spawnSync("security", ["-i"], { input: `${command}\n`, encoding: "utf8" });
      if (res.status !== 0 || /error/i.test(res.stderr)) throw new Error(`keychain write failed: ${res.stderr.trim() || `exit ${res.status}`}`);
    },
  };
}

/** In-memory store for tests and platforms without a keychain. */
export function memorySecretStore(): SecretStore {
  const secrets = new Map<string, string>();
  return {
    get: (service, account) => secrets.get(`${service}\u0000${account}`) ?? null,
    set: (service, account, secret) => void secrets.set(`${service}\u0000${account}`, secret),
  };
}

export const hasKeychain = () => process.platform === "darwin" && spawnSync("which", ["security"]).status === 0;

export const AGENT_KEY_SERVICE = "bap-agent";
export const LINKEN_SPHERE_SERVICE = "bap-linken-sphere";

/** Creates a throwaway keychain file for tests; returns its path. */
export function createTestKeychain(path: string, password = "test"): string {
  execFileSync("security", ["create-keychain", "-p", password, path]);
  execFileSync("security", ["unlock-keychain", "-p", password, path]);
  execFileSync("security", ["set-keychain-settings", path]); // no auto-lock during the test
  return path;
}

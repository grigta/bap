import type { Database, ProfileStatus } from "@bap/database";
import type { Kysely } from "kysely";

/**
 * Allowed profile transitions: the §7.2 diagram plus the VERIFYING entries from ADR-0022
 * (manual verify, enable, lease expiry before acceptance). Every profile status change goes through moveProfile.
 */
export const PROFILE_TRANSITIONS: Record<ProfileStatus, readonly ProfileStatus[]> = {
  AVAILABLE: ["RESERVED", "VERIFYING", "DISABLED"],
  RESERVED: ["IN_USE", "AVAILABLE", "VERIFYING"],
  IN_USE: ["VERIFYING"],
  VERIFYING: ["AVAILABLE", "NEEDS_REVIEW"],
  NEEDS_REVIEW: ["AVAILABLE", "VERIFYING", "DISABLED"],
  DISABLED: ["VERIFYING"],
};

export const canMoveProfile = (from: ProfileStatus, to: ProfileStatus) => PROFILE_TRANSITIONS[from].includes(to);

export class IllegalProfileTransition extends Error {}

/**
 * Atomic status change: only from the listed states, so concurrent callers cannot both win.
 * Asking for a transition outside the table is a programming error and throws.
 */
export async function moveProfile(
  db: Kysely<Database>,
  id: string,
  from: ProfileStatus[],
  to: ProfileStatus,
  extra: { last_error?: string | null; active_run_id?: string | null; last_verified_at?: Date } = {},
): Promise<{ id: string; agent_id: string; external_profile_id: string } | undefined> {
  for (const f of from) if (!canMoveProfile(f, to)) throw new IllegalProfileTransition(`profile transition ${f} → ${to} is not allowed`);
  return db
    .updateTable("profiles")
    .set({ status: to, updated_at: new Date(), ...extra })
    .where("id", "=", id)
    .where("status", "in", from)
    .returning(["id", "agent_id", "external_profile_id"])
    .executeTakeFirst();
}

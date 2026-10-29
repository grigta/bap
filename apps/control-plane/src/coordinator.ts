import { type Db, type RunStatus, isDatabaseUnavailable } from "@bap/database";
import { sql } from "kysely";
import { type RunEvent, message } from "@bap/protocol";
import { WARMUP_FAILURES_TO_REVIEW, farmingSettings, needsWarmProfile, queueWarmup } from "./farming.ts";
import { AgentRequestError, type Fleet, type FleetConfig, connection } from "./fleet.ts";
import { moveProfile } from "./profile-states.ts";

export interface SchedulerConfig {
  /** A lease lives this long without a heartbeat from its owner. */
  leaseTtlMs: number;
  /** An assignment not accepted within this time goes back to the queue. */
  acceptTimeoutMs: number;
  tickMs: number;
}

export const DEFAULT_SCHEDULER: SchedulerConfig = { leaseTtlMs: 60_000, acceptTimeoutMs: 30_000, tickMs: 1000 };

/** Why a run is still waiting; shown to the operator. */
export type QueueReason =
  | "AGENT_DISABLED"
  | "AGENT_DRAINING"
  | "AGENT_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "AGENT_AT_CAPACITY"
  | "PROFILE_BUSY"
  | "PROFILE_NEEDS_REVIEW"
  | "PROFILE_DISABLED"
  /** A recipe waits until its profile has had enough warm-up sessions (PRD §17). */
  | "PROFILE_WARMING";

const ACTIVE_RUN: RunStatus[] = ["ASSIGNED", "ACCEPTED", "RUNNING", "CANCEL_REQUESTED"];

export interface CoordinatorHooks {
  /** A run reached SUCCEEDED (recipes turn healed steps into a new version here). */
  onSucceeded?: (runId: string) => Promise<void>;
  /** Profiles the operator is working in (remote browser): runs on them wait. */
  remoteProfiles?: () => Set<string>;
}

export function createCoordinator(db: Db, fleet: Fleet, fleetConfig: FleetConfig, config: SchedulerConfig, hooks: CoordinatorHooks = {}) {
  /** Changes run status only from the listed states and journals the change in the same transaction. */
  const transitionRun = (
    runId: string,
    from: RunStatus[],
    to: RunStatus,
    reason: string | null,
    extra: Partial<{ error_code: string; error_message: string; started_at: Date; finished_at: Date; queue_reason: string | null }> = {},
  ) =>
    db.transaction().execute(async (tx) => {
      const before = await tx.selectFrom("runs").select("status").where("id", "=", runId).where("status", "in", from).forUpdate().executeTakeFirst();
      if (!before) return false;
      await tx.updateTable("runs").set({ status: to, updated_at: new Date(), ...extra }).where("id", "=", runId).execute();
      await tx.insertInto("run_transitions").values({ run_id: runId, from_status: before.status, to_status: to, reason }).execute();
      return true;
    });

  const effectiveLimit = (agent: { max_sessions: number | null; capabilities: unknown }) =>
    agent.max_sessions ?? (agent.capabilities as { maxSessions?: number } | null)?.maxSessions ?? 1;

  /** Reserves the run's profile and assigns the run. Exactly one concurrent caller per profile can win. */
  const reserve = async (runId: string): Promise<boolean> => {
    let assigned = false;
    try {
      await db.transaction().execute(async (tx) => {
        const run = await tx.selectFrom("runs").select(["profile_id", "agent_id", "status"]).where("id", "=", runId).forUpdate().executeTakeFirstOrThrow();
        if (run.status !== "QUEUED") throw new Abort();
        // The primary key on profile_id is the guarantee: a second lease insert fails.
        const lease = await tx
          .insertInto("profile_leases")
          .values({ profile_id: run.profile_id, run_id: runId, owner_agent_id: run.agent_id, expires_at: new Date(Date.now() + config.leaseTtlMs) })
          .onConflict((oc) => oc.column("profile_id").doNothing())
          .returning("profile_id")
          .executeTakeFirst();
        if (!lease) throw new Abort();
        if (!(await moveProfile(tx, run.profile_id, ["AVAILABLE"], "RESERVED", { active_run_id: runId }))) throw new Abort();
        await tx.updateTable("runs").set({ status: "ASSIGNED", updated_at: new Date(), queue_reason: null }).where("id", "=", runId).execute();
        await tx.insertInto("run_transitions").values({ run_id: runId, from_status: "QUEUED", to_status: "ASSIGNED", reason: `profile reserved, assigned to agent ${run.agent_id}` }).execute();
        await tx.insertInto("run_assignments").values({ run_id: runId, agent_id: run.agent_id }).execute();
        assigned = true;
      });
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
    }
    return assigned;
  };

  /** Releases a reservation that never turned into a running browser. */
  const unreserve = async (runId: string, profileId: string, reason: string) => {
    await transitionRun(runId, ["ASSIGNED"], "QUEUED", reason);
    // Close this attempt so that the accept timeout of the next one starts from its own assignment.
    await db.updateTable("run_assignments").set({ status: "ABANDONED", finished_at: new Date() }).where("run_id", "=", runId).where("finished_at", "is", null).execute();
    await moveProfile(db, profileId, ["RESERVED"], "AVAILABLE", { active_run_id: null });
    await db.deleteFrom("profile_leases").where("run_id", "=", runId).execute();
  };

  const send = async (runId: string) => {
    const run = await db
      .selectFrom("runs")
      .innerJoin("profiles", "profiles.id", "runs.profile_id")
      .innerJoin("scenarios", "scenarios.id", "runs.scenario_id")
      .select(["runs.agent_id", "runs.profile_id", "runs.input", "runs.timeout_ms", "runs.scenario_id", "runs.scenario_version", "runs.resume_requested", "runs.kind", "scenarios.kind as scenario_kind", "scenarios.start_url", "scenarios.inputs", "profiles.external_profile_id"])
      .where("runs.id", "=", runId)
      .executeTakeFirstOrThrow();
    let version = run.scenario_version;
    // A recipe run takes the newest published version: healing elsewhere may have produced one since it was queued.
    // A resumed run keeps its version, its checkpoints refer to those steps.
    if (run.kind === "run" && run.scenario_kind === "recipe" && !run.resume_requested) {
      const latest = await db.selectFrom("scenario_versions").select("version").where("scenario_id", "=", run.scenario_id).where("published_at", "is not", null).orderBy("published_at", "desc").executeTakeFirst();
      if (latest && latest.version !== version) {
        await db.updateTable("runs").set({ scenario_version: latest.version }).where("id", "=", runId).execute();
        version = latest.version;
      }
    }
    const sha256 = version ? (await db.selectFrom("scenario_versions").select("sha256").where("scenario_id", "=", run.scenario_id).where("version", "=", version).executeTakeFirstOrThrow()).sha256 : "";
    const inputs = (run.inputs ?? []) as { name: string; secret: boolean }[];
    const sent = fleet.send(
      run.agent_id,
      message({
        type: "run.assign",
        payload: {
          runId,
          scenario: { id: run.scenario_id, version: version ?? (run.kind === "farm" ? "builtin" : "recording"), sha256, kind: run.scenario_kind },
          ...(run.kind === "record" && { recording: { startUrl: run.start_url!, secretInputs: inputs.filter((i) => i.secret).map((i) => i.name) } }),
          profileExternalId: run.external_profile_id,
          input: run.input,
          timeoutMs: run.timeout_ms,
          resume: run.resume_requested,
        },
      }),
    );
    if (!sent) await unreserve(runId, run.profile_id, "agent disconnected before the assignment was sent");
  };

  /** One warm-up at a time per profile: a new one is queued only when none is waiting or running. */
  const warmUp = async (profileId: string, agentId: string, done: number, required: number) => {
    const pending = await db.selectFrom("runs").select("id").where("profile_id", "=", profileId).where("kind", "=", "farm").where("status", "not in", ["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"]).executeTakeFirst();
    if (!pending) await queueWarmup(db, { id: profileId, agent_id: agentId }, await farmingSettings(db), `warm-up ${done + 1} of ${required} before a recipe`);
  };

  /** Counts a finished warm-up; the third failure in a row sends the profile to review (PRD §17.3). */
  const countWarmup = async (runId: string, ok: boolean): Promise<boolean> => {
    const run = await db.selectFrom("runs").select(["kind", "profile_id"]).where("id", "=", runId).executeTakeFirstOrThrow();
    if (run.kind !== "farm") return false;
    const counted = await db
      .updateTable("profiles")
      .set(ok ? { warmups: sql`warmups + 1`, warmup_failures: 0 } : { warmup_failures: sql`warmup_failures + 1` })
      .where("id", "=", run.profile_id)
      .returning("warmup_failures")
      .executeTakeFirstOrThrow();
    return !ok && counted.warmup_failures >= WARMUP_FAILURES_TO_REVIEW;
  };

  /** Walks the queue oldest first and assigns what the §7.4 criteria allow; records why the rest waits. */
  const schedule = async () => {
    const queued = await db
      .selectFrom("runs")
      .innerJoin("profiles", "profiles.id", "runs.profile_id")
      .innerJoin("agents", "agents.id", "runs.agent_id")
      .leftJoin("agent_capabilities", "agent_capabilities.agent_id", "agents.id")
      .innerJoin("scenarios", "scenarios.id", "runs.scenario_id")
      .select([
        "runs.id",
        "runs.agent_id",
        "runs.profile_id",
        "runs.kind",
        "runs.queue_reason",
        "scenarios.kind as scenario_kind",
        "profiles.status as profile_status",
        "profiles.warmups",
        "agents.status as agent_status",
        "agents.last_seen_at",
        "agents.last_heartbeat",
        "agents.max_sessions",
        "agent_capabilities.payload as capabilities",
      ])
      .where("runs.status", "=", "QUEUED")
      .orderBy("runs.created_at")
      .execute();
    if (queued.length === 0) return;
    const active = await db.selectFrom("runs").select(["agent_id", db.fn.countAll<string>().as("n")]).where("status", "in", ACTIVE_RUN).groupBy("agent_id").execute();
    const busy = new Map(active.map((a) => [a.agent_id, Number(a.n)]));
    const { requiredWarmups } = await farmingSettings(db);
    const warming = new Set<string>();
    // The operator is working in these profiles' browsers (remote sessions): no run may start there.
    const remote = hooks.remoteProfiles?.() ?? new Set<string>();

    for (const r of queued) {
      const reason: QueueReason | null =
        r.agent_status === "DISABLED" || r.agent_status === "REVOKED"
          ? "AGENT_DISABLED"
          : r.agent_status === "DRAINING"
            ? "AGENT_DRAINING"
            : !fleet.isConnected(r.agent_id) || connection(r.last_seen_at, fleetConfig) !== "ONLINE"
              ? "AGENT_UNAVAILABLE"
              : (r.last_heartbeat as { lsAvailable?: boolean } | null)?.lsAvailable !== true
                ? "PROVIDER_UNAVAILABLE"
                : r.profile_status === "NEEDS_REVIEW"
                  ? "PROFILE_NEEDS_REVIEW"
                  : r.profile_status === "DISABLED"
                    ? "PROFILE_DISABLED"
                    : needsWarmProfile(r.kind, r.scenario_kind) && r.warmups < requiredWarmups
                      ? "PROFILE_WARMING"
                      : r.profile_status !== "AVAILABLE" || remote.has(r.profile_id)
                      ? "PROFILE_BUSY"
                      : (busy.get(r.agent_id) ?? 0) >= effectiveLimit(r)
                        ? "AGENT_AT_CAPACITY"
                        : null;
      // Only between runs: right after a failed warm-up the profile is still on its way to review or release.
      if (reason === "PROFILE_WARMING" && r.profile_status === "AVAILABLE" && !warming.has(r.profile_id)) {
        warming.add(r.profile_id);
        await warmUp(r.profile_id, r.agent_id, r.warmups, requiredWarmups);
      }
      if (reason === null && (await reserve(r.id))) {
        busy.set(r.agent_id, (busy.get(r.agent_id) ?? 0) + 1);
        await send(r.id);
        continue;
      }
      const shown = reason ?? "PROFILE_BUSY";
      if (r.queue_reason !== shown) await db.updateTable("runs").set({ queue_reason: shown }).where("id", "=", r.id).where("status", "=", "QUEUED").execute();
    }
  };

  const checking = new Set<string>();
  let stopped = false;
  /** VERIFYING after a run: the owner agent confirms the browser let go of the profile (ADR-0008). */
  const verifyReleased = async (profileId: string) => {
    if (checking.has(profileId) || stopped) return;
    const lease = await db
      .selectFrom("profile_leases")
      .innerJoin("profiles", "profiles.id", "profile_leases.profile_id")
      .innerJoin("runs", "runs.id", "profile_leases.run_id")
      .select(["profile_leases.owner_agent_id", "profiles.external_profile_id", "profiles.status", "runs.status as run_status"])
      .where("profile_leases.profile_id", "=", profileId)
      .executeTakeFirst();
    if (!lease || lease.status !== "VERIFYING" || !fleet.isConnected(lease.owner_agent_id)) return; // retried on the next tick
    checking.add(profileId);
    try {
      let state: string;
      try {
        state = ((await fleet.request(lease.owner_agent_id, { method: "profiles.check", externalId: lease.external_profile_id }, 15_000)) as { state: string }).state;
      } catch (e) {
        if (e instanceof AgentRequestError && (e.code === "AGENT_UNAVAILABLE" || e.code === "AGENT_TIMEOUT")) return;
        state = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
      // The run behind an expired lease may still be working: "busy" then means wait, not review.
      if (state === "busy" && !["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"].includes(lease.run_status)) return;
      // One step: nobody sees the profile free while its lease still holds it.
      await db.transaction().execute(async (tx) => {
        if (state === "idle") await moveProfile(tx, profileId, ["VERIFYING"], "AVAILABLE", { active_run_id: null, last_error: null });
        else
          await moveProfile(tx, profileId, ["VERIFYING"], "NEEDS_REVIEW", {
            active_run_id: null,
            last_error: state === "missing" ? "Profile not found at the provider after the run" : state === "busy" ? "The browser still holds the profile after the run" : state,
          });
        await tx.deleteFrom("profile_leases").where("profile_id", "=", profileId).execute();
      });
    } finally {
      checking.delete(profileId);
    }
  };

  const maintenance = async () => {
    const now = new Date();
    // Assignments the agent never accepted go back to the queue (RESERVED → AVAILABLE).
    const stale = await db
      .selectFrom("runs")
      .innerJoin("run_assignments", "run_assignments.run_id", "runs.id")
      .select(["runs.id", "runs.profile_id"])
      .where("runs.status", "=", "ASSIGNED")
      .where("run_assignments.acknowledged_at", "is", null)
      .where("run_assignments.finished_at", "is", null)
      // assigned_at comes from the database clock (DEFAULT now()), so its age is measured by the same clock:
      // the Control Plane's clock may differ from the database server's by seconds.
      .where("run_assignments.assigned_at", "<", sql<Date>`now() - make_interval(secs => ${config.acceptTimeoutMs / 1000})`)
      .execute();
    for (const r of stale) await unreserve(r.id, r.profile_id, `agent did not accept within ${config.acceptTimeoutMs} ms`);

    // An expired lease does not free the profile: it goes to VERIFYING until the owner confirms it is idle.
    const expired = await db
      .selectFrom("profile_leases")
      .innerJoin("profiles", "profiles.id", "profile_leases.profile_id")
      .select(["profile_leases.profile_id", "profile_leases.run_id", "profiles.status"])
      .where("profile_leases.expires_at", "<", now)
      .where("profiles.status", "in", ["RESERVED", "IN_USE"])
      .execute();
    for (const l of expired) {
      // The run first: whoever sees the profile in VERIFYING already sees its run waiting for recovery.
      // Not accepted yet: the run can wait in the queue, the kept lease blocks the profile until the owner confirms it is idle.
      if (!(await transitionRun(l.run_id, ["ASSIGNED"], "QUEUED", "lease expired before the agent accepted")))
        await transitionRun(l.run_id, ["ACCEPTED", "RUNNING", "CANCEL_REQUESTED"], "RECOVERY_PENDING", "lease expired: no heartbeat from the agent");
      await moveProfile(db, l.profile_id, ["RESERVED", "IN_USE"], "VERIFYING");
    }

    // autoResume (REQ-RUN-007): once the owner is back and the profile is confirmed idle, continue by itself.
    const recoverable = await db
      .selectFrom("runs")
      .leftJoin("profile_leases", "profile_leases.run_id", "runs.id")
      .select(["runs.id", "runs.agent_id"])
      .where("runs.status", "=", "RECOVERY_PENDING")
      .where("runs.auto_resume", "=", true)
      .where("profile_leases.run_id", "is", null)
      .execute();
    for (const r of recoverable) if (fleet.isConnected(r.agent_id)) await requestResume(r.id, "autoResume");

    const verifying = await db
      .selectFrom("profile_leases")
      .innerJoin("profiles", "profiles.id", "profile_leases.profile_id")
      .select("profile_leases.profile_id")
      .where("profiles.status", "=", "VERIFYING")
      .execute();
    for (const v of verifying) await verifyReleased(v.profile_id);
  };

  // Ticks are serialized: the capacity count and reservations assume one scheduler pass at a time.
  let queue = Promise.resolve();
  const tick = () => (queue = queue.then(async () => {
    if (stopped) return; // e.g. a heartbeat arriving while the app shuts down
    await maintenance();
    await schedule();
  }).catch((e) =>
    // Every tick fails while the database is away; one line each is enough.
    isDatabaseUnavailable(e) ? console.warn(`scheduler tick skipped: database unavailable (${e.message})`) : console.error("scheduler tick failed", e),
  ));

  const isResume = async (runId: string) =>
    (await db.selectFrom("run_transitions").select("id").where("run_id", "=", runId).where("reason", "like", "resume requested%").executeTakeFirst()) !== undefined;

  /** RECOVERY_PENDING → QUEUED with the resume flag: the agent continues from its last checkpoint. */
  const requestResume = async (runId: string, by: "operator" | "autoResume") => {
    const last = await db.selectFrom("checkpoints").select(["sequence", "step_id"]).where("run_id", "=", runId).orderBy("sequence", "desc").executeTakeFirst();
    const from = last ? `checkpoint ${last.sequence} (${last.step_id})` : "the start";
    const moved = await transitionRun(runId, ["RECOVERY_PENDING"], "QUEUED", `resume requested by ${by} from ${from}`);
    if (moved) await db.updateTable("runs").set({ resume_requested: true }).where("id", "=", runId).execute();
    return moved;
  };

  /** Cancel (REQ-RUN-003): queued or stalled runs stop at once; running ones at the next step boundary. */
  const cancel = async (runId: string): Promise<"cancelled" | "requested" | "conflict"> => {
    if (await transitionRun(runId, ["QUEUED"], "CANCELLED", "cancelled by the operator before it started", { finished_at: new Date() })) return "cancelled";
    if (await transitionRun(runId, ["RECOVERY_PENDING"], "CANCELLED", "cancelled by the operator during recovery", { finished_at: new Date() })) return "cancelled";
    const run = await db.selectFrom("runs").select(["agent_id", "profile_id"]).where("id", "=", runId).executeTakeFirst();
    if (!run) return "conflict";
    // Not accepted yet: no browser is working on it, so it ends now and the reservation is released.
    if (await transitionRun(runId, ["ASSIGNED"], "CANCELLED", "cancelled by the operator before the agent accepted", { finished_at: new Date() })) {
      await moveProfile(db, run.profile_id, ["RESERVED"], "AVAILABLE", { active_run_id: null });
      await db.deleteFrom("profile_leases").where("run_id", "=", runId).execute();
      await db.updateTable("run_assignments").set({ status: "ABANDONED", finished_at: new Date() }).where("run_id", "=", runId).where("finished_at", "is", null).execute();
      fleet.send(run.agent_id, message({ type: "run.cancel", payload: { runId } }));
      return "cancelled";
    }
    if (!(await transitionRun(runId, ["ACCEPTED", "RUNNING"], "CANCEL_REQUESTED", "cancel requested by the operator"))) return "conflict";
    fleet.send(run.agent_id, message({ type: "run.cancel", payload: { runId } })); // resent when the agent reconnects
    return "requested";
  };

  const afterRun = async (runId: string, outcome: "release" | "review", lastError: string | null) => {
    const run = await db.selectFrom("runs").select("profile_id").where("id", "=", runId).executeTakeFirstOrThrow();
    await moveProfile(db, run.profile_id, ["IN_USE", "RESERVED"], "VERIFYING");
    if (outcome === "review") {
      // An unconfirmed change keeps the profile blocked until an operator looks at it.
      await moveProfile(db, run.profile_id, ["VERIFYING"], "NEEDS_REVIEW", { active_run_id: null, last_error: lastError });
      await db.deleteFrom("profile_leases").where("profile_id", "=", run.profile_id).execute();
    } else void verifyReleased(run.profile_id).catch((e) => stopped || console.error("verify after run failed", e)); // never await an agent request inside its socket handler
    await db.updateTable("run_assignments").set({ status: "FINISHED", finished_at: new Date() }).where("run_id", "=", runId).execute();
  };

  fleet.handlers.onConnected = async (agentId, report) => {
    for (const runId of report.interruptedRuns) {
      const run = await db.selectFrom("runs").select(["status", "profile_id", "agent_id"]).where("id", "=", runId).executeTakeFirst();
      if (run?.agent_id !== agentId) continue;
      if (await transitionRun(runId, ["CANCEL_REQUESTED"], "CANCELLED", "agent restarted while the cancel was pending", { finished_at: new Date() })) {
        await moveProfile(db, run.profile_id, ["IN_USE", "RESERVED"], "VERIFYING");
        continue;
      }
      // The browser died with the agent: the profile is checked before anything else uses it.
      if (await transitionRun(runId, ["ASSIGNED", "ACCEPTED", "RUNNING"], "RECOVERY_PENDING", "agent restarted mid-run"))
        await moveProfile(db, run.profile_id, ["IN_USE", "RESERVED"], "VERIFYING");
    }
    // A run the agent kept executing through a dropped connection, or finished with its result still
    // on the way, is not lost: it waits for the agent's buffered events instead of being resumed.
    for (const runId of report.activeRuns) {
      const run = await db.selectFrom("runs").select("agent_id").where("id", "=", runId).executeTakeFirst();
      if (run?.agent_id === agentId) await transitionRun(runId, ["RECOVERY_PENDING"], "RUNNING", "agent still has the run: executing or results on the way");
    }
    const cancelling = await db.selectFrom("runs").select("id").where("agent_id", "=", agentId).where("status", "=", "CANCEL_REQUESTED").execute();
    for (const r of cancelling) fleet.send(agentId, message({ type: "run.cancel", payload: { runId: r.id } }));
    void tick();
  };
  fleet.handlers.onHeartbeat = async (agentId) => {
    await db.updateTable("profile_leases").set({ expires_at: new Date(Date.now() + config.leaseTtlMs) }).where("owner_agent_id", "=", agentId).execute();
    void tick();
  };
  fleet.handlers.onRunEvent = async (agentId, event: RunEvent) => {
    const runId = event.payload.runId;
    const owner = await db.selectFrom("runs").select(["agent_id", "profile_id"]).where("id", "=", runId).executeTakeFirst();
    if (owner?.agent_id !== agentId) return; // an agent may only report on its own runs
    switch (event.type) {
      case "run.accepted":
        if (await transitionRun(runId, ["ASSIGNED"], "ACCEPTED", "agent accepted")) await moveProfile(db, owner.profile_id, ["RESERVED"], "IN_USE");
        else if ((await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirstOrThrow()).status === "CANCELLED")
          fleet.send(agentId, message({ type: "run.cancel", payload: { runId } })); // accepted too late: stop it
        await db.updateTable("runs").set({ resume_requested: false }).where("id", "=", runId).execute();
        await db.updateTable("run_assignments").set({ status: "ACCEPTED", acknowledged_at: new Date() }).where("run_id", "=", runId).where("acknowledged_at", "is", null).execute();
        break;
      case "run.started": {
        const { autoResume, resumedAfter } = event.payload;
        await db.updateTable("runs").set({ auto_resume: autoResume }).where("id", "=", runId).execute();
        const reason = resumedAfter ? `resumed after checkpoint ${resumedAfter}` : (await isResume(runId)) ? "resumed from the start (no checkpoint)" : "agent started the scenario";
        await transitionRun(runId, ["ACCEPTED"], "RUNNING", reason, { started_at: new Date() });
        break;
      }
      case "run.checkpoint": {
        const c = event.payload;
        await db
          .insertInto("checkpoints")
          .values({ run_id: runId, sequence: c.sequence, step_id: c.stepId, next_step_id: c.nextStepId, next_step_mutating: c.nextStepMutating, auto_resume: c.autoResume, created_at: c.createdAt })
          .onConflict((oc) => oc.columns(["run_id", "sequence"]).doNothing())
          .execute();
        break;
      }
      case "run.cancelled":
        if (
          await transitionRun(runId, ["CANCEL_REQUESTED", "ACCEPTED", "RUNNING", "RECOVERY_PENDING"], "CANCELLED", event.payload.afterStep ? `cancelled after step ${event.payload.afterStep}` : "cancelled before the first step", {
            finished_at: new Date(),
          })
        )
          await afterRun(runId, "release", null);
        break;
      case "run.progress": {
        const step = event.payload.step;
        const shot = step.screenshot
          ? await db.selectFrom("artifacts").select("id").where("run_id", "=", runId).where("name", "=", step.screenshot).executeTakeFirst()
          : undefined;
        const failure = step.failure
          ? await db.selectFrom("artifacts").select("id").where("run_id", "=", runId).where("name", "=", step.failure).executeTakeFirst()
          : undefined;
        await db
          .insertInto("run_steps")
          .values({
            run_id: runId,
            sequence: step.sequence,
            step_id: step.stepId,
            mutating: step.mutating,
            status: step.status,
            started_at: step.startedAt,
            duration_ms: step.durationMs,
            error: step.error ?? null,
            screenshot_artifact_id: shot?.id ?? null,
            failure_artifact_id: failure?.id ?? null,
            intent: step.intent ?? null,
            resolution: step.resolution ?? null,
            note: step.note ?? null,
          })
          .onConflict((oc) => oc.columns(["run_id", "sequence"]).doNothing())
          .execute();
        break;
      }
      case "run.completed":
        // RECOVERY_PENDING: the lease expired but the agent finished after all.
        if (await transitionRun(runId, ["RUNNING", "RECOVERY_PENDING", "CANCEL_REQUESTED"], "SUCCEEDED", "all steps passed", { finished_at: new Date() })) {
          await countWarmup(runId, true);
          await afterRun(runId, "release", null);
          await hooks.onSucceeded?.(runId).catch((e) => console.error(`after run ${runId} succeeded`, e));
        }
        break;
      case "run.failed": {
        const { status, errorCode, message: text } = event.payload;
        // ASSIGNED: the agent may refuse an assignment outright (e.g. DUPLICATE_ASSIGNMENT).
        const moved = await transitionRun(runId, ["ASSIGNED", "ACCEPTED", "RUNNING", "RECOVERY_PENDING", "CANCEL_REQUESTED"], status, `${errorCode}: ${text}`, { error_code: errorCode, error_message: text, finished_at: new Date() });
        if (moved) {
          const giveUp = await countWarmup(runId, false);
          await afterRun(runId, status === "NEEDS_REVIEW" || giveUp ? "review" : "release", giveUp ? `warm-up failed ${WARMUP_FAILURES_TO_REVIEW} times in a row; last: ${errorCode}: ${text}` : `run ${runId}: ${text}`);
        }
        break;
      }
    }
    void tick();
  };

  let timer: NodeJS.Timeout | null = null;
  return {
    transitionRun,
    reserve,
    requestResume: (runId: string) => requestResume(runId, "operator").then(async (ok) => (void tick(), ok)),
    cancel,
    tick,
    start() {
      timer ??= setInterval(() => void tick(), config.tickMs);
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await queue;
    },
  };
}

export type Coordinator = ReturnType<typeof createCoordinator>;

class Abort extends Error {}

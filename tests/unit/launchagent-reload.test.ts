import { expect, test } from "vitest";
import { reloadLaunchAgent } from "../../apps/mac-agent/src/launchagent.ts";

/** A launchctl that keeps the old service around for a while and refuses bootstrap until it is gone. */
function fakeLaunchctl(goneAfterPrints: number, bootstrapFailures: number) {
  const calls: string[] = [];
  let prints = 0;
  let failures = 0;
  const run = (args: string[]) => {
    calls.push(args[0]!);
    if (args[0] === "print") return { status: ++prints > goneAfterPrints ? 113 : 0, stderr: "" };
    if (args[0] === "bootstrap") return failures++ < bootstrapFailures ? { status: 5, stderr: "Bootstrap failed: 5: Input/output error" } : { status: 0, stderr: "" };
    return { status: 0, stderr: "" };
  };
  return { run, calls };
}

test("an already loaded agent is unloaded completely before the new one is loaded; a transient EIO is retried", async () => {
  const launchctl = fakeLaunchctl(2, 1);
  await reloadLaunchAgent("/tmp/com.bap.agent.plist", 501, launchctl.run, async () => {});
  expect(launchctl.calls).toEqual(["bootout", "print", "print", "print", "bootstrap", "bootstrap"]);
});

test("a bootstrap that keeps failing ends with a clear message, not a stack trace", async () => {
  const launchctl = fakeLaunchctl(0, 99);
  await expect(reloadLaunchAgent("/tmp/com.bap.agent.plist", 501, launchctl.run, async () => {})).rejects.toThrow(/could not start the agent with launchd.*Input\/output error/);
});

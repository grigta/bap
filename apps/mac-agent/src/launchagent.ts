import { homedir } from "node:os";
import { join } from "node:path";

export const LAUNCH_AGENT_LABEL = "com.bap.agent";
export const launchAgentPath = () => join(homedir(), "Library/LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** LaunchAgent that starts `bap-agent start` at login and restarts it if it exits. */
export function launchAgentPlist(opts: { node: string; cli: string; logFile: string; env: Record<string, string> }): string {
  const args = [opts.node, opts.cli, "start"].map((a) => `    <string>${escape(a)}</string>`).join("\n");
  const env = Object.entries(opts.env)
    .map(([k, v]) => `    <key>${escape(k)}</key>\n    <string>${escape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escape(opts.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(opts.logFile)}</string>
</dict>
</plist>
`;
}

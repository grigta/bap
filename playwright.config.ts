import { defineConfig, devices } from "@playwright/test";
import { STACK_PORTS } from "./tests/e2e/stack-config.ts";

const testSitePort = 4310;
const shapeshiftPort = 4320;
const farmPort = 4330;
// Agents enrolled by e2e tests keep their keys in files, never in the developer's login keychain.
process.env.BAP_KEY_STORAGE = "file";
// ... and never touch a real LS Clicker in the developer's ~/Developer/ls-clicker (a test passes its own directory).
process.env.BAP_LS_CLICKER_DIR = "";
// ... nor take its screen when a fake run fails.
process.env.BAP_NO_SCREENSHOT = "1";

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  // One shared stack; some tests stop the Control Plane, so files must not run in parallel.
  workers: 1,
  // Partial or evidence runs set BAP_JUNIT so they do not overwrite the full-suite report.
  reporter: [["list"], ["junit", { outputFile: process.env.BAP_JUNIT ?? "reports/junit/e2e.xml" }], ["html", { open: "never" }], ["./tests/e2e/fault-report.ts"]],
  use: { baseURL: `http://127.0.0.1:${STACK_PORTS.web}`, trace: "retain-on-failure" },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node tests/fixtures/test-site/server.ts",
      env: { PORT: String(testSitePort) },
      url: `http://127.0.0.1:${testSitePort}`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node tests/fixtures/shapeshift-site/server.ts",
      env: { PORT: String(shapeshiftPort) },
      url: `http://127.0.0.1:${shapeshiftPort}/api/layout`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "node tests/fixtures/farm-site/server.ts",
      env: { PORT: String(farmPort) },
      url: `http://127.0.0.1:${farmPort}/log`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // PostgreSQL in Testcontainers + Control Plane + web; the first run may pull images
      command: "node tests/e2e/stack.ts",
      env: { TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: "/var/run/docker.sock" },
      url: `http://127.0.0.1:${STACK_PORTS.web}`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});

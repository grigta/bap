import { defineConfig, devices } from "@playwright/test";
import { STACK_PORTS } from "./tests/e2e/stack-config.ts";

const testSitePort = 4310;

export default defineConfig({
  testDir: "tests/e2e",
  forbidOnly: !!process.env.CI,
  // One shared stack; some tests stop the Control Plane, so files must not run in parallel.
  workers: 1,
  reporter: [["list"], ["junit", { outputFile: "reports/junit/e2e.xml" }], ["html", { open: "never" }]],
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
      // PostgreSQL in Testcontainers + Control Plane + web; the first run may pull images
      command: "node tests/e2e/stack.ts",
      env: { TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: "/var/run/docker.sock" },
      url: `http://127.0.0.1:${STACK_PORTS.web}`,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});

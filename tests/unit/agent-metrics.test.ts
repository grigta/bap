import { totalmem } from "node:os";
import { expect, test } from "vitest";
import { memoryPercent } from "../../apps/mac-agent/src/agent.ts";

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    60681.
Pages active:                                 214129.
Pages inactive:                               212865.
Pages wired down:                             182037.
Pages purgeable:                                3420.
File-backed pages:                            126035.
Anonymous pages:                              301401.
Pages occupied by compressor:                 334649.
`;

test("macOS memory use counts app, wired and compressed pages, not the file cache", () => {
  // (301401 - 3420 + 182037 + 334649) pages × 16 KiB of 16 GiB
  expect(memoryPercent(VM_STAT, 17_179_869_184)).toBe(77.7);
});

test("other platforms fall back to free memory", () => {
  const value = memoryPercent(null, totalmem());
  expect(value).toBeGreaterThan(0);
  expect(value).toBeLessThanOrEqual(100);
});

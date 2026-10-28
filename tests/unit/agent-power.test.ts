import { expect, test } from "vitest";
import { parsePower } from "../../apps/mac-agent/src/power.ts";

const batt = (source: string, battery?: string) => `Now drawing from '${source}'\n${battery ? ` -InternalBattery-0 (id=7209059)\t${battery} present: true\n` : ""}`;
const settings = (lines: string) => `System-wide power settings:\nCurrently in use:\n standby              1\n${lines}\n hibernatemode        3\n`;

test("a MacBook on the charger reports AC, its charge and whether it is charging", () => {
  expect(parsePower(batt("AC Power", "76%; charging; 0:42 remaining"), settings(" sleep                0"))).toEqual({ source: "ac", batteryPercent: 76, charging: true, sleepPrevented: true });
  expect(parsePower(batt("AC Power", "80%; AC attached; not charging"), settings(" sleep                0\n SleepDisabled        1"))).toEqual({ source: "ac", batteryPercent: 80, charging: false, sleepPrevented: true });
  expect(parsePower(batt("AC Power", "100%; charged; 0:00 remaining"), settings(" sleep                1"))).toEqual({ source: "ac", batteryPercent: 100, charging: false, sleepPrevented: false });
});

test("a MacBook taken off the charger reports battery power", () => {
  expect(parsePower(batt("Battery Power", "89%; discharging; 10:29 remaining"), settings(" sleep                1 (sleep prevented by caffeinate, powerd)"))).toEqual({ source: "battery", batteryPercent: 89, charging: false, sleepPrevented: false });
});

test("SleepDisabled alone (lid closed allowed) counts as sleep prevented", () => {
  expect(parsePower(batt("AC Power", "50%; charging;"), settings(" sleep                10\n SleepDisabled        1")).sleepPrevented).toBe(true);
});

test("a desktop Mac has no battery", () => {
  expect(parsePower(batt("AC Power"), settings(" sleep                0"))).toEqual({ source: "ac", batteryPercent: null, charging: null, sleepPrevented: true });
});

test("unknown output reports nothing it cannot read", () => {
  expect(parsePower("", "")).toEqual({ source: "unknown", batteryPercent: null, charging: null, sleepPrevented: null });
});

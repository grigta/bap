import { isDatabaseUnavailable } from "@bap/database";
import { expect, test } from "vitest";

test("[REQ-RUN-011] connection failures count as an unavailable database; query errors do not", () => {
  const err = (code: string | undefined, message = "x") => Object.assign(new Error(message), code ? { code } : {});
  for (const e of [err("ECONNREFUSED"), err("ECONNRESET"), err("08006"), err("57P01"), err(undefined, "Connection terminated unexpectedly"), err(undefined, "timeout exceeded when trying to connect")])
    expect(isDatabaseUnavailable(e)).toBe(true);
  for (const e of [err("23505", "duplicate key"), err("42P01", "relation does not exist"), err(undefined, "boom"), null, undefined]) expect(isDatabaseUnavailable(e)).toBe(false);
});

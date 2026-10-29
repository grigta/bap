#!/usr/bin/env node
// A stand-in for `api-anything call spokeo phoneLookup phone=…`: prints its JSON line like the real one.
const [, , cmd, site, op, arg] = process.argv;
if (cmd !== "call" || site !== "spokeo" || op !== "phoneLookup") process.exit(2);
const phone = (arg ?? "").replace(/^phone=/, "");
console.log("api-anything: calling spokeo");
console.log(JSON.stringify({ ok: true, data: { owner: phone === "415-712-3489" ? "" : "Someone" }, home: process.env.HOME }));

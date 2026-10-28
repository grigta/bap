import { defineScenario } from "@bap/scenario-sdk";
import wizardOrder from "../../../../scenarios/wizard-order/index.ts";

/** wizard-order that resumes by itself after a failure when it is provably safe. */
export default defineScenario({ ...wizardOrder, id: "wizard-order-auto", autoResume: true });

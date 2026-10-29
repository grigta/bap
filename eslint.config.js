import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", "coverage/", "reports/", "playwright-report/", "test-results/", "dist/", "artifacts/", ".scratch/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Plain Node scripts (test stand-ins run as executables): TypeScript files get these from @types/node.
  { files: ["**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly", setTimeout: "readonly", fetch: "readonly" } } },
);

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", "coverage/", "reports/", "playwright-report/", "test-results/", "dist/", "artifacts/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);

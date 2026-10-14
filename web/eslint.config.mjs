import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Quartz design-system code is installed from its registry and kept as shipped
    "src/components/quartz/**",
    "src/lib/quartz/**",
  ]),
  {
    rules: {
      // fetch-then-setState inside effects is the data-loading pattern used across the app
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
// NOTE: could not auto-insert rule override

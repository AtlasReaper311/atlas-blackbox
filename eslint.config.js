// Atlas Systems — canonical ESLint flat config for Cloudflare Workers.
import js from "@eslint/js";
import globals from "globals";
export default [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    // atlas-blackbox ships Node CLI scripts (publish/unpublish) alongside
    // the Worker itself. The canonical block above is scoped to **/*.js,
    // so it never reaches these; without this block, no-undef would fail
    // on plain Node globals like process, since nothing declares them.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
];

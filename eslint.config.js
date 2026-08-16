import js from "@eslint/js";

/**
 * The bridge spawns subprocesses and parses JSON produced by other people's
 * CLIs, so the rules worth enforcing are the ones that catch a genuinely wrong
 * program — unused bindings, unreachable code, promises nobody awaits — not
 * stylistic preferences.
 */
export default [
  {
    ignores: ["node_modules/**", ".acp-team/**"]
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        queueMicrotask: "readonly",
        structuredClone: "readonly",
        AbortController: "readonly",
        TextDecoder: "readonly",
        URL: "readonly",
        fetch: "readonly",
        Response: "readonly",
        globalThis: "readonly"
      }
    },
    rules: {
      // Leading underscore marks a binding kept for shape but not read, as in
      // the destructuring that strips private reasoning off a run result.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": ["error", { allow: ["log", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"]
    }
  },
  {
    files: ["src/**/*.test.js", "src/**/*smoke-test.js", "src/**/*adapter-test.js"],
    rules: { "no-console": "off" }
  }
];

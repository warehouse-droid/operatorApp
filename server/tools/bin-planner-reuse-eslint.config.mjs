import { readFileSync } from "node:fs";
import existing from "../eslint.mbt.config.js";
// These are two classic scripts sharing a browser realm, with an explicit
// adapter loaded only by mbt-planning.html. Validate names against the host.
const source = readFileSync("public/dispatch.js", "utf8") + readFileSync("public/dispatch-auth.js", "utf8");
const hostGlobals = Object.fromEntries([...source.matchAll(/^(?:async\s+)?(?:function|let|const)\s+([\w$]+)/gm)].map(match => [match[1], "writable"]));
export default [...existing, {
  files: ["public/mbt-planning.js"],
  languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: {
    ...hostGlobals, window: "readonly", document: "readonly", fetch: "readonly", URLSearchParams: "readonly", Response: "readonly", structuredClone: "readonly", clearTimeout: "readonly"
  } },
  rules: { "no-undef": "error", "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-unreachable": "error", curly: ["error", "all"], eqeqeq: ["error", "always"], "prefer-const": "error" }
}];

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const files = ["src/dispatch-po-route-projection.js", "src/dispatch-history-mode.js", "src/dispatch-completion-repository.js",
  "test/dispatch/unit/dispatch-special-po-lifecycle.test.js", "test/dispatch/property/dispatch-special-po-lifecycle.test.js",
  "test/dispatch/integration/dispatch-special-po-lifecycle.test.js", "tools/dispatch-special-po-suites.mjs",
  "tools/dispatch-special-po-mutations.mjs", "tools/dispatch-special-po-static.mjs", "tools/dispatch-special-po-eslint.config.mjs"];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) { throw new Error(result.stderr); }
}
for (const [name, command, args] of [
  ["lint", "node_modules/.bin/eslint", ["--config", "tools/dispatch-special-po-eslint.config.mjs", "--format", "json", ...files]],
  ["types", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"]]
]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if (result.error || result.stderr) { throw result.error || new Error(result.stderr); }
  writeFileSync(`test-artifacts/${name}.log`, result.stdout);
  console.log(JSON.stringify({ name, exitCode: result.status, syntaxFiles: files.length }));
}

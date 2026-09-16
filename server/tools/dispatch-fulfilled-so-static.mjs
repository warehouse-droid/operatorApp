import { existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const directory = "test-artifacts/dispatch-so-fulfilled-planning";
const label = process.argv[2] || "current";
const files = ["src/dispatch-fulfilled-so-policy.js", "src/dispatch-fulfilled-so-repository.js", "src/dispatch-repository.js",
  "src/dispatch-plan-repository.js", "src/dispatch-planner-v2-repository.js", "src/dispatch-order-catalog-repository.js",
  "src/sales-order-reconciliation.js", "src/server.js", "public/dispatch.js"].filter(existsSync);
for (const [name, command, args] of [
  ["types", "node_modules/.bin/tsc", ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"]],
  ["lint", "node_modules/.bin/eslint", ["--config", "tools/dispatch-fulfilled-so-eslint.config.mjs", "--format", "json", ...files]]
]) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 });
  if (result.error) { throw result.error; }
  writeFileSync(`${directory}/${name}-${label}.log`, `${result.stdout}${result.stderr}`);
  console.log(JSON.stringify({ name, label, exitCode: result.status }));
}

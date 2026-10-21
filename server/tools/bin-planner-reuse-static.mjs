import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const files = ["src/mbt/bin-planning-board.js", "src/mbt/bin-planning-domain.js", "src/mbt/bin-planning-metadata.js", "src/mbt/bin-planning-service.js", "src/mbt/bin-planning-assignments.js", "src/mbt/bin-dispatch-service.js", "public/dispatch.js", "public/mbt-planning.js", "src/dispatch-load-assignment.js", "src/driver-repository.js", "src/server.js"];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status) throw new Error(result.stderr);
}
const lint = spawnSync(process.execPath, ["node_modules/eslint/bin/eslint.js", "--config", "tools/bin-planner-reuse-eslint.config.mjs", "--max-warnings=0",
  ...files.filter(file => !["public/dispatch.js", "src/dispatch-load-assignment.js", "src/driver-repository.js", "src/server.js"].includes(file)), ...(process.argv.includes("--fix-report") ? ["--fix-dry-run", "--format=json"] : [])], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
writeFileSync("test-artifacts/reuse-lint.json", lint.stdout);
if (process.argv.includes("--fix-report")) { console.log(lint.stderr || "Formatting report written"); process.exit(lint.status); }
console.log(lint.stdout, lint.stderr);
const typed = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "--project", "tsconfig.mbt.json", "--pretty", "false"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
writeFileSync("test-artifacts/reuse-types.log", typed.stdout + typed.stderr);
const diagnostics = typed.stdout.split("\n").filter(line => /error TS\d+/.test(line));
const affected = diagnostics.filter(line => files.filter(file => file.startsWith("src/mbt/")).some(file => line.startsWith(`${file}(`)));
console.log(JSON.stringify({ syntaxFiles: files.length, lintExit: lint.status, changedTypeErrors: affected, importedGraphDiagnostics: diagnostics.length }, null, 2));
process.exitCode = lint.status || (affected.length || diagnostics.length > 254 || typed.error ? 1 : 0);

// @ts-check

import { spawnSync } from "node:child_process";
import path from "node:path";

const tsc = path.resolve("node_modules/.bin/tsc");
const result = spawnSync(tsc, ["--project", "tsconfig.mbt.json", "--noEmit", "--pretty", "false"], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8"
});
if (result.error) {
  throw result.error;
}
const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
const diagnostics = output.split("\n").map((line) => line.trim()).filter((line) => /: error TS\d+:/u.test(line));
const allowedBaseline = new Set();
const unexpected = diagnostics.filter((diagnostic) => !allowedBaseline.has(diagnostic));
const missingBaseline = [...allowedBaseline].filter((diagnostic) => !diagnostics.includes(diagnostic));
if (unexpected.length || diagnostics.length !== allowedBaseline.size || missingBaseline.length) {
  process.stderr.write(`${output}\n`);
  throw new Error(
    `Static-type baseline changed: ${unexpected.length} unexpected and ${missingBaseline.length} missing diagnostic(s).`
  );
}
console.log(`Static types held at zero new errors (${allowedBaseline.size} documented pre-existing diagnostics).`);

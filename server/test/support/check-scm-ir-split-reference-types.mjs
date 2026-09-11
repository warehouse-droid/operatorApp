// @ts-check

import { spawnSync } from "node:child_process";

const acceptedBaselineDiagnostics = new Set([
  "test/support/check-dispatch-derived-order-freshness-coverage.mjs(112,28): error TS2532: Object is possibly 'undefined'.",
  "test/support/run-dispatch-repeat-pickup-mutations.mjs(86,17): error TS7006: Parameter 'value' implicitly has an 'any' type.",
  "test/support/run-dispatch-repeat-pickup-mutations.mjs(90,26): error TS7006: Parameter 'source' implicitly has an 'any' type.",
  "test/support/run-dispatch-repeat-pickup-mutations.mjs(90,34): error TS7006: Parameter 'needle' implicitly has an 'any' type."
]);

const result = spawnSync(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "--project",
  "tsconfig.mbt.json",
  "--noEmit"
], {
  cwd: process.cwd(),
  encoding: "utf8"
});

if (result.error) {
  throw result.error;
}

const output = `${result.stdout || ""}${result.stderr || ""}`;
const diagnostics = output
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line.includes(": error TS"));
const unexpected = diagnostics.filter((line) => !acceptedBaselineDiagnostics.has(line));

if (unexpected.length > 0 || (result.status !== 0 && diagnostics.length === 0)) {
  process.stderr.write(output);
  throw new Error("SCM IR split-reference work introduced a new type-check diagnostic.");
}

if (diagnostics.length > 0) {
  process.stdout.write(
    `SCM IR split-reference type check added no diagnostics; ${diagnostics.length}`
    + " accepted pre-feature dispatch diagnostics remain.\n"
  );
} else {
  process.stdout.write("SCM IR split-reference type check passed with no diagnostics.\n");
}

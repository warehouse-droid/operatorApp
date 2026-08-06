// @ts-check

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const INTEGRATION_TARGETS = Object.freeze([
  "test/mbt/integration/frontdesk-workflow.test.js",
  "test/mbt/integration/frontdesk-adversarial.test.js"
]);
const RACE_TARGETS = Object.freeze([
  "test/mbt/concurrency/frontdesk-races.test.js"
]);

const MUTANTS = Object.freeze([
  {
    name: "Front Desk role guard is bypassed",
    from: "if (!roles.some((role) => FRONTDESK_ROLES.has(role))) {",
    to: "if (false && !roles.some((role) => FRONTDESK_ROLES.has(role))) {"
  },
  {
    name: "quote row lock is removed",
    from: "      FOR UPDATE OF q`,",
    to: "      `,",
    targetTests: RACE_TARGETS
  },
  {
    name: "mismatched template and rate card are accepted",
    from: "if (configuration.rate_template_id\n          && String(configuration.rate_template_id) !== String(configuration.template_id)) {",
    to: "if (false && configuration.rate_template_id\n          && String(configuration.rate_template_id) !== String(configuration.template_id)) {"
  },
  {
    name: "rate effective window is ignored",
    from: "if ((effectiveFrom && proposedDeliveryAt < effectiveFrom)\n          || (effectiveTo && proposedDeliveryAt >= effectiveTo)) {",
    to: "if (false && ((effectiveFrom && proposedDeliveryAt < effectiveFrom)\n          || (effectiveTo && proposedDeliveryAt >= effectiveTo))) {"
  },
  {
    name: "invalid distance route fingerprint is accepted",
    from: "if (!/^[0-9a-f]{64}$/.test(routeHash)) {",
    to: "if (false && !/^[0-9a-f]{64}$/.test(routeHash)) {"
  },
  {
    name: "unsafe exact-cent total is accepted",
    from: "if (!Number.isSafeInteger(totalMinor)) {",
    to: "if (false && !Number.isSafeInteger(totalMinor)) {"
  },
  {
    name: "non-accepted quote conversion is permitted",
    from: "if (before.status !== \"accepted\") {",
    to: "if (false && before.status !== \"accepted\") {",
    targetTests: RACE_TARGETS
  },
  {
    name: "return leg is dispatch-ready before its predecessor",
    from: "        serviceAction: \"return_bin\",\n        status: \"tentative\",",
    to: "        serviceAction: \"return_bin\",\n        status: \"ready\","
  },
  {
    name: "return leg loses its predecessor relationship",
    from: "        binTypeId: String(quoteRow.bin_type_id),\n        predecessorVisitId: deliveryVisitId,\n        scheduledStartAt: returnAt,",
    to: "        binTypeId: String(quoteRow.bin_type_id),\n        predecessorVisitId: null,\n        scheduledStartAt: returnAt,"
  },
  {
    name: "cancelled contract extension is permitted",
    from: "if (![\"confirmed\", \"active\", \"return_due\"].includes(beforeContract.status)) {",
    to: "if (false && ![\"confirmed\", \"active\", \"return_due\"].includes(beforeContract.status)) {"
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {readonly string[]} targets */
function runTests(targets) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      ...targets
    ], { env: process.env, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Front Desk mutation detector exited on signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Front Desk mutations may run only in the explicitly ephemeral MBT test image.");
}

const target = path.resolve("src/mbt/frontdesk-service.js");
let killed = 0;
for (const mutant of MUTANTS) {
  const original = await readFile(target, "utf8");
  const originalHash = sha256(original);
  if (occurrences(original, mutant.from) !== 1) {
    throw new Error(`${mutant.name}: expected exactly one mutation target.`);
  }
  try {
    await writeFile(target, original.replace(mutant.from, mutant.to), "utf8");
    const exitCode = await runTests(mutant.targetTests || INTEGRATION_TARGETS);
    if (exitCode === 0) {
      throw new Error(`${mutant.name}: survived the Front Desk detector set.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
  } finally {
    await writeFile(target, original, "utf8");
    if (sha256(await readFile(target)) !== originalHash) {
      throw new Error(`${mutant.name}: source restoration hash mismatch.`);
    }
  }
}

console.log(`Front Desk mutation score: ${killed}/${MUTANTS.length} killed (100%).`);

// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const FRONTEND_TESTS = Object.freeze([
  "test/dispatch/frontend/dispatch-completion-ui.test.js"
]);
const DATABASE_TESTS = Object.freeze([
  "test/mbt/adversarial/dispatch-completion-repository-adversarial.test.js",
  "test/mbt/integration/dispatch-completion-status.red.test.js",
  "test/mbt/integration/dispatch-completion-http.red.test.js",
  "test/mbt/integration/dispatch-completion-migration.test.js",
  "test/mbt/concurrency/dispatch-completion-races.test.js"
]);
/**
 * @typedef {{
 *   name: string,
 *   target: string,
 *   from: string,
 *   to: string,
 *   occurrences?: number,
 *   extraDatabaseTests?: string[]
 * }} CompletionMutant
 */
/** @type {ReadonlyArray<CompletionMutant>} */
const MUTANTS = Object.freeze([
  {
    name: "manual recovery no longer requires explicit confirmation",
    target: "src/dispatch-completion-repository.js",
    from: "  if (input.confirm !== true) {",
    to: "  if (false && input.confirm !== true) {"
  },
  {
    name: "Sales users can record manual completion",
    target: "src/dispatch-completion-repository.js",
    from: "  if (!operatorId || !roles.some((role) => [\"admin\", \"dispatcher\"].includes(role))) {",
    to: "  if (!operatorId) {"
  },
  {
    name: "canonical completion no longer admits a missing-route order",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "      chargeable: true,\n      automaticRateWarning:",
    to: "      chargeable: candidate.chargeable === true,\n      automaticRateWarning:"
  },
  {
    name: "a missing route is priced as a zero-distance automatic route",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "  if (stops.length < 2\n      || stops.some((stop) => !text(stop.addressText))\n      || !stops.some((stop) => text(stop.stopType).toLowerCase() === \"dropoff\")) {",
    to: "  if (false) {"
  },
  {
    name: "direct-pickup TO fallback candidates are discarded",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "  const retainedDirectDependencyCandidates = plannedDirectDependencyCandidates.filter(notCoveredByDriver);",
    to: "  const retainedDirectDependencyCandidates = [];"
  },
  {
    name: "source Sales candidates bypass Driver deduplication",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "    ...salesCandidates.filter(notCoveredByDriver),",
    to: "    ...salesCandidates,"
  },
  {
    name: "Dispatch order feeds omit canonical completion evidence",
    target: "src/server.js",
    from: "  return enrichDispatchOrdersWithCompletionStatus(searchedOrders);",
    to: "  return searchedOrders;"
  },
  {
    name: "Dispatch keeps manual completion enabled after completion",
    target: "public/dispatch.js",
    from: "${!SALES_PLANNING_HOST && !dispatchCompleted && !reviewOnly",
    to: "${!SALES_PLANNING_HOST && true && !reviewOnly"
  },
  {
    name: "historical Driver drops are not backfilled",
    target: "migrations/159_dispatch_order_completion_status.sql",
    from: " WHERE record.status = 'complete'\n   AND lower(btrim(record.stop_type)) = 'dropoff'",
    to: " WHERE false\n   AND lower(btrim(record.stop_type)) = 'dropoff'"
  },
  {
    name: "direct dependency completion is neither projected nor backfilled",
    target: "migrations/159_dispatch_order_completion_status.sql",
    occurrences: 2,
    from: "dependency_mode = 'direct_to_customer'",
    to: "dependency_mode = 'disabled_by_mutant'"
  },
  {
    name: "manual-rate candidates can starve an automatically routable Driver load",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "  items.sort((left, right) => Number(\n    right.chargeable === true && !text(right.automaticRateWarning)\n  ) - Number(left.chargeable === true && !text(left.automaticRateWarning))\n    || Number(right.chargeable) - Number(left.chargeable)",
    to: "  items.sort((left, right) => Number(right.chargeable) - Number(left.chargeable)",
    extraDatabaseTests: ["test/mbt/integration/mbbs-billing-candidates.test.js"]
  },
  {
    name: "universal completion reintroduces Pick-Up into the default Delivery list",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "        AND ($6::boolean\n          OR completion.order_kind <> 'SO'",
    to: "        AND (true\n          OR completion.order_kind <> 'SO'",
    extraDatabaseTests: ["test/mbt/integration/mbbs-order-billing-v3.red.test.js"]
  },
  {
    name: "a corrected billing address keeps its stale automatic-rate warning",
    target: "src/mbt/mbbs-billing-candidate-service.js",
    from: "    reason: null,\n    automaticRateWarning: null,\n    addressOverride: publicOverride,",
    to: "    reason: null,\n    automaticRateWarning: candidate.automaticRateWarning,\n    addressOverride: publicOverride,",
    extraDatabaseTests: ["test/mbt/integration/mbbs-billing-candidates.test.js"]
  }
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function runFrontendTests() {
  const result = spawnSync(process.execPath, [
    "--test",
    "--test-concurrency=1",
    ...FRONTEND_TESTS
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

/** @param {string} label @param {string[]} [databaseTests] */
async function runFocusedTests(label, databaseTests = [...DATABASE_TESTS]) {
  const frontend = runFrontendTests();
  if (frontend !== 0) {
    return frontend;
  }
  return runNodeTestFilesIsolated(databaseTests, {
    environment: process.env,
    label
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Dispatch order-completion mutations require the writable disposable MBT test container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const source = await readFile(path.resolve(target), "utf8");
  originals.set(target, source);
  hashes.set(target, sha256(source));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string") {
      throw new Error(`Missing mutation source ${mutant.target}.`);
    }
    const expectedOccurrences = mutant.occurrences || 1;
    if (occurrenceCount(original, mutant.from) !== expectedOccurrences) {
      throw new Error(`${mutant.name}: expected ${expectedOccurrences} mutation target occurrence(s).`);
    }
    await writeFile(
      path.resolve(mutant.target),
      original.replaceAll(mutant.from, mutant.to),
      "utf8"
    );
    const result = await runFocusedTests(
      `Dispatch order-completion mutant: ${mutant.name}`,
      [...DATABASE_TESTS, ...(mutant.extraDatabaseTests || [])]
    );
    if (result === 0) {
      throw new Error(`${mutant.name}: survived its focused regressions.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (sha256(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Dispatch order-completion mutation source restoration failed for ${target}.`);
    }
  }
}

const finalExtraDatabaseTests = [...new Set(MUTANTS.flatMap(
  (mutant) => mutant.extraDatabaseTests || []
))];
const finalResult = await runFocusedTests(
  "Dispatch order-completion post-mutation green",
  [...DATABASE_TESTS, ...finalExtraDatabaseTests]
);
if (finalResult !== 0) {
  throw new Error("Dispatch order-completion tests failed after source restoration.");
}
console.log(`Dispatch order-completion mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);

// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/operator-linked-fulfillment.red.test.js",
  "test/mbt/unit/operator-linked-fulfillment-ui.red.test.js",
  "test/mbt/unit/sales-order-auto-fulfillment.red.test.js",
  "test/mbt/unit/sales-order-auto-fulfillment-service.red.test.js",
  "test/mbt/unit/sales-order-auto-fulfillment-wiring.red.test.js",
  "test/mbt/property/operator-linked-fulfillment.property.test.js",
  "test/mbt/integration/operator-linked-quantity-repository.red.test.js",
  "test/mbt/integration/sales-order-auto-fulfillment-migration.red.test.js"
]);

const MUTANTS = Object.freeze([
  Object.freeze({
    name: "linked supply is added to Operator work",
    target: "src/operator-linked-quantity-domain.js",
    from: "operatorRequired[unit] = Number(Math.max(original[unit] - linkedTotal[unit], 0).toFixed(6));",
    to: "operatorRequired[unit] = Number(Math.max(original[unit] + linkedTotal[unit], 0).toFixed(6));"
  }),
  Object.freeze({
    name: "yard replenishment is treated as direct supply",
    target: "src/operator-linked-quantity-domain.js",
    from: "if (status === \"cancelled\" || mode !== \"direct_to_customer\") {continue;}",
    to: "if (status === \"cancelled\") {continue;}"
  }),
  Object.freeze({
    name: "linked over-allocation no longer blocks",
    target: "src/operator-linked-quantity-domain.js",
    from: "if (linkedTotal[unit] > original[unit] + EPSILON) {",
    to: "if (false && linkedTotal[unit] > original[unit] + EPSILON) {"
  }),
  Object.freeze({
    name: "cancelled PO allocations reduce Operator work",
    target: "src/delivery-repository.js",
    from: "WHERE a.status = 'active'\n       AND a.sales_line_id = ${lineAlias}.id",
    to: "WHERE a.status <> 'missing'\n       AND a.sales_line_id = ${lineAlias}.id"
  }),
  Object.freeze({
    name: "yard replenishment SQL reduces Operator work",
    target: "src/delivery-repository.js",
    from: "AND d.dependency_mode = 'direct_to_customer'\n       AND d.status <> 'cancelled'",
    to: "AND d.dependency_mode = 'yard_replenishment'\n       AND d.status <> 'cancelled'"
  }),
  Object.freeze({
    name: "Delivery SO target ownership returns to Operator",
    target: "src/operator-netsuite-posting-targets.js",
    from: "      ? \"driver_completion\"\n      : \"operator\";",
    to: "      ? \"operator\"\n      : \"operator\";"
  }),
  Object.freeze({
    name: "Driver-owned Delivery SO reaches Operator command admission",
    target: "src/operator-netsuite-posting-admission.js",
    from: "if (resolution.netSuitePostingOwner === \"driver_completion\") {",
    to: "if (false && resolution.netSuitePostingOwner === \"driver_completion\") {"
  }),
  Object.freeze({
    name: "direct TO quantity is omitted from delivered conservation",
    target: "src/sales-order-auto-fulfillment-domain.js",
    from: "const deliveredQuantity = Number((operatorLoadedQuantity + completedPoQuantity + completedDirectToQuantity).toFixed(6));",
    to: "const deliveredQuantity = Number((operatorLoadedQuantity + completedPoQuantity).toFixed(6));"
  }),
  Object.freeze({
    name: "duplicate PO allocation evidence is accepted",
    target: "src/sales-order-auto-fulfillment-domain.js",
    from: "if (new Set(normalized.map((row) => row.allocationId)).size !== normalized.length) {",
    to: "if (false && new Set(normalized.map((row) => row.allocationId)).size !== normalized.length) {"
  }),
  Object.freeze({
    name: "duplicate TO dependency evidence is accepted",
    target: "src/sales-order-auto-fulfillment-domain.js",
    from: "if (new Set(normalized.map((row) => row.dependencyId)).size !== normalized.length) {",
    to: "if (false && new Set(normalized.map((row) => row.dependencyId)).size !== normalized.length) {"
  }),
  Object.freeze({
    name: "already fulfilled snapshot lines are posted again",
    target: "src/sales-order-auto-fulfillment-domain.js",
    from: "        || current.fulfilledQuantity + EPSILON < request.quantity;",
    to: "        || true;"
  }),
  Object.freeze({
    name: "unselected NetSuite lines are fulfilled",
    target: "src/sales-order-auto-fulfillment-domain.js",
    from: ": { orderLine: line.orderLine, itemReceive: false, ...(location ? { location } : {}) };",
    to: ": { orderLine: line.orderLine, itemReceive: true, ...(location ? { location } : {}) };"
  }),
  Object.freeze({
    name: "pre-transform external-ID recovery is skipped",
    target: "src/sales-order-auto-fulfillment-service.js",
    from: "record = preRecoveredRecord || await adapter.findByExternalId(candidate);",
    to: "record = preRecoveredRecord;"
  }),
  Object.freeze({
    name: "uncertain posts automatically transform again",
    target: "src/sales-order-auto-fulfillment-service.js",
    from: "if (candidate.status === \"uncertain\" && rawResolutionAction(candidate) !== \"recover\") {",
    to: "if (false && candidate.status === \"uncertain\" && rawResolutionAction(candidate) !== \"recover\") {"
  }),
  Object.freeze({
    name: "remote work begins without a lease renewal",
    target: "src/sales-order-auto-fulfillment-service.js",
    from: "    await repository.renew({\n      candidateId: candidate.id,\n      leaseToken: candidate.leaseToken,\n      leaseSeconds\n    });",
    to: "    await Promise.resolve({\n      candidateId: candidate.id,\n      leaseToken: candidate.leaseToken,\n      leaseSeconds\n    });"
  }),
  Object.freeze({
    name: "yard gate off no longer fences claim",
    target: "src/sales-order-auto-fulfillment-repository.js",
    from: "               AND flag.enabled = true",
    to: "               AND true"
  }),
  Object.freeze({
    name: "new activation watermark no longer fences old automatic work",
    target: "src/sales-order-auto-fulfillment-repository.js",
    from: "                   candidate.completion_event_id > watermark.activation_event_id",
    to: "                   candidate.completion_event_id >= 0"
  }),
  Object.freeze({
    name: "uncertain candidates re-enter the automatic runnable queue",
    target: "src/sales-order-auto-fulfillment-repository.js",
    from: "WHERE status IN ('discovered', 'waiting_evidence', 'queued')",
    to: "WHERE status IN ('discovered', 'waiting_evidence', 'queued', 'uncertain')"
  }),
  Object.freeze({
    name: "direct TO evidence accepts a different customer-drop job",
    target: "src/sales-order-auto-fulfillment-repository.js",
    from: "        AND ($3 <> 'driver_job' OR dependency.direct_receipt_job_id = $4)",
    to: "        AND true"
  }),
  Object.freeze({
    name: "first automatic SO IF gate defaults on",
    target: "migrations/180_sales_order_completion_fulfillment.sql",
    from: "('dispatch_netsuite_sales_order_if_3445', false,",
    to: "('dispatch_netsuite_sales_order_if_3445', true,"
  }),
  Object.freeze({
    name: "direct dependency completion creates an SO IF candidate",
    target: "migrations/180_sales_order_completion_fulfillment.sql",
    from: "OR NEW.completion_evidence_type NOT IN ('driver_job', 'manual_dispatch') THEN",
    to: "OR NEW.completion_evidence_type NOT IN ('driver_job', 'manual_dispatch', 'direct_dependency') THEN"
  }),
  Object.freeze({
    name: "completion worker transforms a TO instead of the Sales Order",
    target: "src/sales-order-auto-fulfillment-netsuite-adapter.js",
    from: "sourceOrderKind: \"SO\"",
    to: "sourceOrderKind: \"TO\""
  })
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[operator-linked mutation] ${label}\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...TESTS], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) {throw result.error;}
  return Object.freeze({
    status: result.status ?? 1,
    output: `${result.stdout || ""}${result.stderr || ""}`
  });
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Operator linked-fulfillment mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map(({ target }) => target))];
const originals = new Map();
const hashes = new Map();
for (const target of targets) {
  const retained = await readFile(path.resolve(target), "utf8");
  originals.set(target, retained);
  hashes.set(target, sha256(retained));
}

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originals.get(mutant.target);
    if (typeof original !== "string") {throw new Error(`Missing mutation source ${mutant.target}.`);}
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    const mutationResult = runTests(mutant.name);
    if (mutationResult.status === 0) {
      process.stdout.write(mutationResult.output);
      throw new Error(`${mutant.name}: survived the focused suite.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(path.resolve(mutant.target), original, "utf8");
  }
} finally {
  for (const [target, original] of originals) {
    await writeFile(path.resolve(target), original, "utf8");
    if (sha256(await readFile(path.resolve(target), "utf8")) !== hashes.get(target)) {
      throw new Error(`Mutation source restoration failed for ${target}.`);
    }
  }
}

const restoredResult = runTests("post-mutation restored source");
if (restoredResult.status !== 0) {
  process.stdout.write(restoredResult.output);
  throw new Error("Focused tests failed after restoring mutation sources.");
}
console.log(`Operator linked-fulfillment mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);

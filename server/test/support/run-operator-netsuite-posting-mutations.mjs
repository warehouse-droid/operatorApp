// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const TESTS = Object.freeze([
  "test/mbt/unit/operator-netsuite-posting-admission.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-domain.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-policy.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-route-freeze.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-runtime.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-schema.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-service.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-targets.red.test.js",
  "test/mbt/unit/operator-netsuite-posting-ui.red.test.js",
  "test/mbt/property/operator-netsuite-posting.property.test.js",
  "test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js",
  "test/mbt/integration/operator-netsuite-posting-policy-repository.red.test.js",
  "test/mbt/integration/operator-netsuite-posting-repository.red.test.js",
  "test/mbt/concurrency/operator-netsuite-posting-concurrency.test.js"
]);

const MUTANTS = Object.freeze([
  Object.freeze({
    name: "deployment ceiling is ignored",
    target: "src/operator-netsuite-posting-policy.js",
    from: "effective: configured && environmentAllowed,",
    to: "effective: configured || environmentAllowed,"
  }),
  Object.freeze({
    name: "legacy 2967 location is not canonicalized",
    target: "src/operator-netsuite-posting-policy.js",
    from: "if (normalized === \"13\") {return 28;}",
    to: "if (normalized === \"13\") {return 13;}"
  }),
  Object.freeze({
    name: "stale effective policy is accepted",
    target: "src/operator-netsuite-posting-policy.js",
    from: "return typeof supplied.effective === \"boolean\" && supplied.effective === actual?.effective;",
    to: "return typeof supplied.effective === \"boolean\";"
  }),
  Object.freeze({
    name: "unselected parent lines are received",
    target: "src/operator-netsuite-posting-domain.js",
    from: "{ itemReceive: false }",
    to: "{ itemReceive: true }"
  }),
  Object.freeze({
    name: "split quantities no longer aggregate",
    target: "src/operator-netsuite-posting-domain.js",
    from: "(current?.quantity || 0) + line.quantity",
    to: "(current?.quantity || 0) - line.quantity"
  }),
  Object.freeze({
    name: "live remaining quantity no longer caps a transform",
    target: "src/operator-netsuite-posting-domain.js",
    from: "Math.min(requestedQuantity, available.remainingQuantity)",
    to: "requestedQuantity"
  }),
  Object.freeze({
    name: "fully reconciled lines still create a remote transform step",
    target: "src/operator-netsuite-posting-domain.js",
    from: "hasPost: [...postedByLine.values()].some((quantity) => quantity > 0)",
    to: "hasPost: [...postedByLine.values()].some((quantity) => quantity >= 0)"
  }),
  Object.freeze({
    name: "stable SuiteQL keys are sent as REST transform lines",
    target: "src/operator-netsuite-posting-targets.js",
    from: "restOrderLine: line?.identityStatus === \"exact\" ? exactRestSourceLine(line, sourceItems) : null",
    to: "restOrderLine: line?.identityStatus === \"exact\" ? positiveInteger(line.sourceLineKey) : null"
  }),
  Object.freeze({
    name: "source item fetch returns REST subresource link stubs",
    target: "src/netsuite.js",
    from: "`/record/v1/${recordType}/${id}?expandSubResources=true`",
    to: "`/record/v1/${recordType}/${id}/item`"
  }),
  Object.freeze({
    name: "expanded source item rows are read from the wrong envelope",
    target: "src/netsuite.js",
    from: "const items = result.data?.item?.items;",
    to: "const items = result.data?.items;"
  }),
  Object.freeze({
    name: "linked NetSuite IR IF evidence is ignored",
    target: "src/operator-netsuite-posting-targets.js",
    from: "Math.max(positiveNumber(line.cumulativeProgressQuantity), linkedQuantity)",
    to: "positiveNumber(line.cumulativeProgressQuantity)"
  }),
  Object.freeze({
    name: "deterministic external ID loses its request binding",
    target: "src/operator-netsuite-posting-domain.js",
    from: "return `MBBS-OP-${normalizedRequestId}-${normalizedStep}`;",
    to: "return `MBBS-OP-${normalizedStep}`;"
  }),
  Object.freeze({
    name: "remote line location mismatch is accepted",
    target: "src/operator-netsuite-posting-adapter.js",
    from: "if (actualLocation !== Number(expected.location)) {",
    to: "if (false && actualLocation !== Number(expected.location)) {"
  }),
  Object.freeze({
    name: "NetSuite REST id references are ignored during exact verification",
    target: "src/operator-netsuite-posting-adapter.js",
    from: "if (Object.hasOwn(reference, \"id\")) {return Number(reference.id);}",
    to: "if (Object.hasOwn(reference, \"id\")) {return Number(reference.value);}"
  }),
  Object.freeze({
    name: "external-ID recovery is no longer scoped to its source transaction",
    target: "src/operator-netsuite-posting-netsuite-adapter.js",
    from: "      const found = await findTransactionByExternalId(\n        step.externalId,\n        step.transactionType,\n        step.sourceNetSuiteId\n      );",
    to: "      const found = await findTransactionByExternalId(\n        step.externalId,\n        step.transactionType\n      );"
  }),
  Object.freeze({
    name: "linked IF IR recovery ignores the exact source transaction",
    target: "src/netsuite.js",
    from: "     WHERE transaction_link.previousdoc = ${sourceId}",
    to: "     WHERE transaction_link.previousdoc > 0"
  }),
  Object.freeze({
    name: "linked IF IR recovery accepts a different external ID",
    target: "src/netsuite.js",
    from: "    if (recordExternalId !== normalizedExternalId) continue;",
    to: "    if (false && recordExternalId !== normalizedExternalId) continue;"
  }),
  Object.freeze({
    name: "external-ID recovery lookup is skipped",
    target: "src/operator-netsuite-posting-service.js",
    from: "const existing = await verifiedExternalRecord(step);",
    to: "const existing = null;"
  }),
  Object.freeze({
    name: "timeouts are treated as definitive no-write failures",
    target: "src/operator-netsuite-posting-service.js",
    from: "if (status === 408 || status === 429 || status >= 500) {return true;}",
    to: "if (status === 408 || status === 429 || status >= 500) {return false;}"
  }),
  Object.freeze({
    name: "remote work runs without renewing the exact lease",
    target: "src/operator-netsuite-posting-service.js",
    from: "    await repository.renew({\n      commandId: command.id,\n      leaseToken: command.leaseToken,\n      leaseSeconds\n    });\n    /** @type {Promise<unknown>} */\n    let renewal = Promise.resolve();",
    to: "    /** @type {Promise<unknown>} */\n    let renewal = Promise.resolve();"
  }),
  Object.freeze({
    name: "gate-off admission creates remote commands",
    target: "src/operator-netsuite-posting-admission.js",
    from: "if (!policy.effective) {",
    to: "if (false && !policy.effective) {"
  }),
  Object.freeze({
    name: "local reattempt child is posted",
    target: "src/operator-netsuite-posting-targets.js",
    from: "(functionKey === \"delivery_prep\" && localOnlyDeliveryOrder(child))",
    to: "(false && functionKey === \"delivery_prep\" && localOnlyDeliveryOrder(child))"
  }),
  Object.freeze({
    name: "delivery finalization skips direct dependency progress",
    target: "src/operator-netsuite-posting-finalizer.js",
    from: "        : await syncDirectDependencies(operation.orderId);",
    to: "        : null;"
  }),
  Object.freeze({
    name: "receiving finalization loses the stable local payload",
    target: "src/operator-netsuite-posting-finalizer.js",
    from: "const payload = command?.inputSnapshot?.localPayload || step?.payload;",
    to: "const payload = step?.payload;"
  }),
  Object.freeze({
    name: "in-process command deduplication is removed",
    target: "src/operator-netsuite-posting-runtime.js",
    from: "if (inFlight.has(commandId)) {return inFlight.get(commandId);}",
    to: "if (false && inFlight.has(commandId)) {return inFlight.get(commandId);}"
  }),
  Object.freeze({
    name: "active command claim guard reads released claims",
    target: "src/operator-netsuite-posting-repository.js",
    from: "WHERE function_key = $1\n        AND local_order_key = ANY($2::text[])\n        AND active = true\n      ORDER BY created_at",
    to: "WHERE function_key = $1\n        AND local_order_key = ANY($2::text[])\n        AND active = false\n      ORDER BY created_at"
  }),
  Object.freeze({
    name: "first Operator posting gate defaults on",
    target: "migrations/178_operator_netsuite_posting_gates.sql",
    from: "('operator_netsuite_customer_pickup_if_3445', false,",
    to: "('operator_netsuite_customer_pickup_if_3445', true,"
  }),
  Object.freeze({
    name: "Admin attention resume is no longer atomic with audit",
    target: "src/server.js",
    from: "    const command = await withTransaction(async () => {\n      const resumed = await resumePublicOperatorNetSuitePostingCommand(req.params.id);",
    to: "    const command = await Promise.resolve().then(async () => {\n      const resumed = await resumePublicOperatorNetSuitePostingCommand(req.params.id);"
  }),
  Object.freeze({
    name: "verified gate-on completion events are not connected",
    target: "src/server.js",
    from: "configureOperatorNetSuitePostingCompletionEvents(emitAppEvent);",
    to: "void emitAppEvent;"
  })
]);

/** @param {string | Buffer} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label */
function runTests(label) {
  process.stdout.write(`\n[operator-posting mutation] ${label}\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...TESTS], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) {throw result.error;}
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Operator posting mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map(({ target }) => target))];
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
    if (typeof original !== "string") {throw new Error(`Missing mutation source ${mutant.target}.`);}
    if (occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runTests(mutant.name) === 0) {throw new Error(`${mutant.name}: survived the focused suite.`);}
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

if (runTests("post-mutation restored source") !== 0) {
  throw new Error("Focused tests failed after restoring mutation sources.");
}
console.log(`Operator posting mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);

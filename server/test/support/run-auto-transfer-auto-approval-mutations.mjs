// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UNIT_TESTS = Object.freeze([
  "test/scm-transfer-dependency-workflow.test.js"
]);

/** @type {ReadonlyArray<{name: string, target: string, from: string, to: string, suite: "unit" | "database"}>} */
const MUTANTS = Object.freeze([
  {
    name: "rejected orderStatus is restored to the create POST",
    target: "src/transfer-dependency-netsuite.js",
    from: "    transferLocation: { id: String(locations.destination.netsuiteLocationId) },\n    memo:",
    to: "    transferLocation: { id: String(locations.destination.netsuiteLocationId) },\n    orderStatus: { id: \"B\" },\n    memo:",
    suite: "unit"
  },
  {
    name: "remote identity is not remembered before approval",
    target: "src/auto-transfer-approval-policy.js",
    from: "  await rememberTransferOrder(transferOrder);\n  if (transferOrder.pendingFulfillment === true) return transferOrder;",
    to: "  void rememberTransferOrder;\n  if (transferOrder.pendingFulfillment === true) return transferOrder;",
    suite: "unit"
  },
  {
    name: "an already-approved recovered TO is PATCHed again",
    target: "src/auto-transfer-approval-policy.js",
    from: "  if (transferOrder.pendingFulfillment === true) return transferOrder;",
    to: "  if (false) return transferOrder;",
    suite: "unit"
  },
  {
    name: "the approval PATCH is silently skipped",
    target: "src/auto-transfer-approval-policy.js",
    from: "    await approveTransferOrder({ transferOrderId, transferOrder, proposal, batch });",
    to: "    await Promise.resolve({ transferOrderId, transferOrder, proposal, batch });",
    suite: "unit"
  },
  {
    name: "post-PATCH status verification is skipped",
    target: "src/auto-transfer-approval-policy.js",
    from: "    transferOrder = await hydrate();",
    to: "    transferOrder = transferOrder;",
    suite: "unit"
  },
  {
    name: "an ambiguous successful PATCH is reported as failed",
    target: "src/auto-transfer-approval-policy.js",
    from: "  if (approvalError && transferOrder.pendingFulfillment !== true) throw approvalError;",
    to: "  if (approvalError) throw approvalError;",
    suite: "unit"
  },
  {
    name: "a confirmed failed PATCH is silently accepted",
    target: "src/auto-transfer-approval-policy.js",
    from: "  if (approvalError && transferOrder.pendingFulfillment !== true) throw approvalError;",
    to: "  if (false && transferOrder.pendingFulfillment !== true) throw approvalError;",
    suite: "unit"
  },
  {
    name: "Auto Transfer approval regresses from Pending Fulfillment to Pending Approval",
    target: "src/server.js",
    from: "      approveTransferOrder: async ({ transferOrderId, proposal, batch }) => {\n        const request = await transferDependencyRestPayload({ proposal, batch });\n        return updateTransferOrderStatusInNetSuite(transferOrderId, {\n          intercompany: request.intercompany,\n          statusId: \"B\"\n        });\n      },\n      hydrateTransferOrder: hydrateCreatedDependencyTransferOrder,\n      findTransferOrder: findCreatedDependencyTransferOrder\n    });\n    emitAppEvent(\"dispatch.orders.updated\", { source: \"scm-transfer-dependency-proposal\"",
    to: "      approveTransferOrder: async ({ transferOrderId, proposal, batch }) => {\n        const request = await transferDependencyRestPayload({ proposal, batch });\n        return updateTransferOrderStatusInNetSuite(transferOrderId, {\n          intercompany: request.intercompany,\n          statusId: \"A\"\n        });\n      },\n      hydrateTransferOrder: hydrateCreatedDependencyTransferOrder,\n      findTransferOrder: findCreatedDependencyTransferOrder\n    });\n    emitAppEvent(\"dispatch.orders.updated\", { source: \"scm-transfer-dependency-proposal\"",
    suite: "unit"
  },
  {
    name: "failed approval discards the recovered TO reference",
    target: "src/order-dependency-repository.js",
    from: "                netsuite_transfer_order_ref = COALESCE(netsuite_transfer_order_ref, $5),",
    to: "                netsuite_transfer_order_ref = NULL,",
    suite: "unit"
  },
  {
    name: "known remote approval failure remains pending instead of recoverable failed",
    target: "src/order-dependency-repository.js",
    from: "                  WHEN $4::bigint IS NOT NULL THEN 'failed'",
    to: "                  WHEN $4::bigint IS NOT NULL THEN 'pending'",
    suite: "unit"
  },
  {
    name: "durable approval status remains pending after confirmed creation",
    target: "src/order-dependency-repository.js",
    from: "                approval_status = $6,",
    to: "                approval_status = 'pending',",
    suite: "database"
  },
  {
    name: "durable approval timestamp is discarded",
    target: "src/order-dependency-repository.js",
    from: "                approved_at = CASE WHEN $6 = 'approved' THEN COALESCE(approved_at, now()) ELSE NULL END,",
    to: "                approved_at = NULL,",
    suite: "database"
  },
  {
    name: "creation accidentally claims a print request",
    target: "src/order-dependency-repository.js",
    from: "                print_job_id = NULL, print_request_status = 'idle',",
    to: "                print_job_id = NULL, print_request_status = 'queueing',",
    suite: "database"
  },
  {
    name: "approved unprinted UI loses pending-print status",
    target: "public/scm-transfer-dependencies.js",
    from: "    || (proposal.approvalStatus === \"approved\" ? \"Pending user print\" : \"not queued\");",
    to: "    || \"not queued\";",
    suite: "unit"
  },
  {
    name: "approved unprinted UI asks for approval again",
    target: "public/scm-transfer-dependencies.js",
    from: "      ? \"Print Source-yard Ticket\"",
    to: "      ? \"Verify, Approve & Print\"",
    suite: "unit"
  }
]);

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} source @param {string} needle */
function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string} label @param {"unit" | "database"} suite */
function runSuite(label, suite) {
  process.stdout.write(`\n[auto-transfer auto-approval mutation] ${label}\n`);
  const args = suite === "database"
    ? ["src/order-dependency-harness.js"]
    : ["--test", "--test-concurrency=1", ...UNIT_TESTS];
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore"
  });
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Auto Transfer auto-approval mutations require the writable disposable MBT mutation container.");
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
    if (typeof original !== "string" || occurrenceCount(original, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target occurrence.`);
    }
    await writeFile(path.resolve(mutant.target), original.replace(mutant.from, mutant.to), "utf8");
    if (runSuite(mutant.name, mutant.suite) === 0) {
      throw new Error(`${mutant.name}: survived the focused regression suite.`);
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

if (runSuite("post-mutation restored unit source", "unit") !== 0
  || runSuite("post-mutation restored database source", "database") !== 0) {
  throw new Error("Focused tests failed after mutation source restoration.");
}
console.log(`Auto Transfer auto-approval mutation score: ${killed}/${MUTANTS.length} killed (100%); sources restored.`);

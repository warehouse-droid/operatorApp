// @ts-check

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runNodeTestFilesIsolated } from "./test-database-isolation.mjs";

const DOMAIN = "test/mbt/unit/delivery-instruction-domain.test.js";
const PROPERTY = "test/mbt/property/delivery-instruction-domain.property.test.js";
const REPOSITORY = "test/mbt/integration/delivery-instruction-repository.test.js";
const HTTP = "test/mbt/integration/delivery-instruction-http.test.js";
const IDENTITY = "test/mbt/unit/delivery-instruction-driver-identity.test.js";
const CONTRACT = "test/mbt/unit/delivery-instruction-contract.test.js";
const OFFLINE_CACHE = "test/mbt/unit/delivery-instruction-offline-cache.test.js";

const MUTANTS = Object.freeze([
  {
    name: "planned address and date lines leak into Driver instructions",
    target: "src/delivery-instruction-domain.js",
    tests: [DOMAIN, PROPERTY],
    from: "const plannedMatch = line.match(ADDRESS_LABEL) || line.match(DATE_TIME_LABEL);",
    to: "const plannedMatch = null;"
  },
  {
    name: "ambiguous memo no longer falls back to the complete raw value",
    target: "src/delivery-instruction-domain.js",
    tests: [DOMAIN, PROPERTY],
    from: "const text = ambiguous ? rawMemo : trimEmptyEdgeLines(retained).join(\"\\n\");",
    to: "const text = trimEmptyEdgeLines(retained).join(\"\\n\");"
  },
  {
    name: "a sixth media file is accepted",
    target: "src/delivery-instruction-domain.js",
    tests: [DOMAIN],
    from: "export const DELIVERY_INSTRUCTION_MAX_MEDIA = 5;",
    to: "export const DELIVERY_INSTRUCTION_MAX_MEDIA = 6;"
  },
  {
    name: "the per-file limit grows beyond 25 MiB",
    target: "src/delivery-instruction-domain.js",
    tests: [DOMAIN],
    from: "export const DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES = 25 * 1024 * 1024;",
    to: "export const DELIVERY_INSTRUCTION_MAX_MEDIA_BYTES = 26 * 1024 * 1024;"
  },
  {
    name: "stale revisions are accepted",
    target: "src/delivery-instruction-domain.js",
    tests: [DOMAIN],
    from: "if (!Number.isSafeInteger(actual) || actual < 0 || expected !== actual) {",
    to: "if (!Number.isSafeInteger(actual) || actual < 0) {"
  },
  {
    name: "Driver-completed drop-offs stay editable",
    target: "src/delivery-instruction-domain.js",
    tests: [DOMAIN, REPOSITORY],
    database: true,
    from: "if (dropoffCompleted) return \"This Sales Order drop-off is completed and its delivery instructions are read-only.\";",
    to: "if (false) return \"This Sales Order drop-off is completed and its delivery instructions are read-only.\";"
  },
  {
    name: "upload object identity ignores its issued UUID",
    target: "src/delivery-instruction-domain.js",
    tests: [DOMAIN],
    from: "&& String(parts[5] || \"\").toLowerCase() === id",
    to: "&& true"
  },
  {
    name: "Sales yard authorization fails open",
    target: "src/delivery-instruction-repository.js",
    tests: [REPOSITORY],
    database: true,
    from: "if (!authorized.includes(Number(row.ordering_location_id))) {",
    to: "if (false && !authorized.includes(Number(row.ordering_location_id))) {"
  },
  {
    name: "stale text edits overwrite the shared instruction",
    target: "src/delivery-instruction-repository.js",
    tests: [REPOSITORY],
    database: true,
    from: "    assertEditable(row);\n    assertDeliveryInstructionRevision(input.expectedRevision, row.revision);\n    await incrementRevision(row, { operatorId: context.operatorId, source, additionalText });",
    to: "    assertEditable(row);\n    assertDeliveryInstructionRevision(row.revision, row.revision);\n    await incrementRevision(row, { operatorId: context.operatorId, source, additionalText });"
  },
  {
    name: "pending uploads no longer reserve one of five slots",
    target: "src/delivery-instruction-repository.js",
    tests: [REPOSITORY],
    database: true,
    from: "       ) + (\n         SELECT COUNT(*)::integer\n           FROM sales_order_delivery_instruction_upload_tickets\n          WHERE sales_order_id = $1\n            AND consumed_at IS NULL\n            AND expires_at > now()\n            AND replacement_media_id IS NULL\n       ) AS count",
    to: "       ) + 0 AS count"
  },
  {
    name: "post-upload registration again rejects a concurrent text edit",
    target: "src/delivery-instruction-repository.js",
    tests: [REPOSITORY],
    database: true,
    from: "    assertEditable(row);\n    const ticketResult = await query(",
    to: "    assertEditable(row);\n    assertDeliveryInstructionRevision(input.expectedRevision, row.revision);\n    const ticketResult = await query("
  },
  {
    name: "exact upload registration retries lose idempotency",
    target: "src/delivery-instruction-repository.js",
    tests: [REPOSITORY],
    database: true,
    from: "    if (existing.rowCount) {",
    to: "    if (false && existing.rowCount) {"
  },
  {
    name: "upload object-reference validation is bypassed",
    target: "src/delivery-instruction-repository.js",
    tests: [REPOSITORY],
    database: true,
    from: "    if (!deliveryInstructionUploadReferenceMatches(input.objectReference, uploadId)) {",
    to: "    if (false && !deliveryInstructionUploadReferenceMatches(input.objectReference, uploadId)) {"
  },
  {
    name: "media replacement loses its gallery position",
    target: "src/delivery-instruction-repository.js",
    tests: [REPOSITORY],
    database: true,
    from: "        replacement ? Number(replacement.position) : Number(countResult.rows[0].max_position) + 1,",
    to: "        Number(countResult.rows[0].max_position) + 1,"
  },
  {
    name: "delivery content contaminates immutable Driver completion identity",
    target: "src/driver-offline-repository.js",
    tests: [IDENTITY],
    from: "    requiredPhotos: snapshot.requiredPhotos,\n    ...(snapshot.mbt ? { mbt: stableMbtOfflineFingerprint(snapshot.mbt) } : {})",
    to: "    requiredPhotos: snapshot.requiredPhotos,\n    deliveryInstructions: snapshot.deliveryInstructions,\n    ...(snapshot.mbt ? { mbt: stableMbtOfflineFingerprint(snapshot.mbt) } : {})"
  },
  {
    name: "Driver content fingerprint ignores delivery instruction edits",
    target: "src/driver-offline-repository.js",
    tests: [IDENTITY],
    from: "export function fingerprintDriverOfflineJobContent(job = {}) {\n  const snapshot = sanitizeDriverOfflineJob(job);",
    to: "export function fingerprintDriverOfflineJobContent(job = {}) {\n  const snapshot = sanitizeDriverOfflineJob(job);\n  delete snapshot.deliveryInstructions;"
  },
  {
    name: "live instruction edits rerender the entire Driver job",
    target: "public/driver.js",
    tests: [CONTRACT],
    from: "  if (details && !photoInteractionActive()) details.outerHTML = renderStopDetails(currentJob);",
    to: "  if (details && !photoInteractionActive()) { renderJob(); details.outerHTML = renderStopDetails(currentJob); }"
  },
  {
    name: "instruction-image cache budget silently grows",
    target: "public/driver-offline-db.js",
    tests: [OFFLINE_CACHE],
    from: "  const MAX_INSTRUCTION_MEDIA_BYTES = 250 * 1024 * 1024;",
    to: "  const MAX_INSTRUCTION_MEDIA_BYTES = 251 * 1024 * 1024;"
  }
]);

/** @param {string} source @param {string} needle */
function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/** @param {string[]} files @param {string} label */
function runLocalTests(files, label) {
  process.stdout.write(`\n[mutation] ${label}\n`);
  const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
    env: process.env,
    stdio: "inherit"
  });
  return result.status ?? 1;
}

if (process.env.MBT_TEST_ISOLATED !== "1" || process.env.MBT_MUTATION_EPHEMERAL !== "1") {
  throw new Error("Delivery-instruction mutations require the writable disposable MBT mutation container.");
}

const targets = [...new Set(MUTANTS.map((mutant) => mutant.target))];
const originals = new Map(await Promise.all(targets.map(async (target) => {
  const absolute = path.resolve(target);
  return /** @type {[string, { absolute: string, source: string }]} */ (
    [target, { absolute, source: await readFile(absolute, "utf8") }]
  );
})));
/** @param {string} target */
function originalFor(target) {
  const original = originals.get(target);
  if (!original) {
    throw new Error(`Missing mutation source snapshot: ${target}`);
  }
  return original;
}
const originalDigest = createHash("sha256");
for (const target of targets) {
  originalDigest.update(originalFor(target).source);
}
const expectedDigest = originalDigest.digest("hex");

let killed = 0;
try {
  for (const mutant of MUTANTS) {
    const original = originalFor(mutant.target);
    if (occurrences(original.source, mutant.from) !== 1) {
      throw new Error(`${mutant.name}: expected exactly one mutation target.`);
    }
    await writeFile(original.absolute, original.source.replace(mutant.from, mutant.to), "utf8");
    const status = mutant.database
      ? await runNodeTestFilesIsolated(mutant.tests, {
        environment: process.env,
        label: `Delivery-instruction mutant: ${mutant.name}`
      })
      : runLocalTests(mutant.tests, mutant.name);
    if (status === 0) {
      throw new Error(`${mutant.name}: survived its focused regression.`);
    }
    killed += 1;
    console.log(`KILLED ${killed}/${MUTANTS.length}: ${mutant.name}`);
    await writeFile(original.absolute, original.source, "utf8");
  }
} finally {
  for (const original of originals.values()) {
    await writeFile(original.absolute, original.source, "utf8");
  }
  const restoredDigest = createHash("sha256");
  for (const target of targets) {
    restoredDigest.update(await readFile(originalFor(target).absolute, "utf8"));
  }
  if (restoredDigest.digest("hex") !== expectedDigest) {
    throw new Error("Delivery-instruction mutation source restoration failed.");
  }
}

const localGreen = runLocalTests([DOMAIN, PROPERTY, IDENTITY, CONTRACT, OFFLINE_CACHE], "post-mutation local green");
const databaseGreen = await runNodeTestFilesIsolated([REPOSITORY, HTTP], {
  environment: process.env,
  label: "Delivery-instruction post-mutation database green"
});
if (localGreen !== 0 || databaseGreen !== 0) {
  throw new Error("Delivery-instruction regressions failed after restoring mutation sources.");
}
console.log(`Delivery-instruction mutation score: ${killed}/${MUTANTS.length} killed (100%); source restored.`);

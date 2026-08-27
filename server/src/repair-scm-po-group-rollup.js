import { closeDb } from "./db.js";
import { repairScmPoScheduleGroupRollup } from "./scm-reconciliation-repository.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
}

const groupRef = option("--group-ref");
const expectedMemberRefs = option("--expected-members")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const actor = option("--actor") || "scm-po-group-rollup-repair";
const apply = process.argv.includes("--apply");

try {
  if (!groupRef || !expectedMemberRefs.length) {
    throw new Error(
      "Usage: node src/repair-scm-po-group-rollup.js --group-ref PGOB-..."
      + " --expected-members PO-1,PO-2 [--actor NAME] [--apply]"
    );
  }
  const result = await repairScmPoScheduleGroupRollup({
    groupRef,
    expectedMemberRefs,
    actor,
    dryRun: !apply
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!apply) {
    process.stdout.write("Dry run only; pass --apply after reviewing the exact group and members.\n");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

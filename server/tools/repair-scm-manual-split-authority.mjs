import { closeDb } from "../src/db.js";
import { repairScmManualSplitFamilyAuthority } from "../src/scm-manual-split-authority-repository.js";

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

const sourcePoRef = argument("source");
const expectedActiveChildren = Number(argument("expected-count"));
const childRefs = argument("children").split(",").map((value) => value.trim()).filter(Boolean);
const expectedCurrentStatus = argument("expected-status");
const replacementStatus = argument("replacement-status");
const actor = argument("actor");
const dryRun = !process.argv.slice(2).includes("--apply");

try {
  const result = await repairScmManualSplitFamilyAuthority({
    sourcePoRef,
    expectedActiveChildren,
    childRefs,
    expectedCurrentStatus,
    replacementStatus,
    actor,
    dryRun
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    error: error?.message || String(error),
    code: error?.code || "SCM_MANUAL_SPLIT_REPAIR_FAILED"
  }, null, 2));
  process.exitCode = 1;
} finally {
  await closeDb();
}

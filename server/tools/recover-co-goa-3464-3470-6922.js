import { closeDb } from "../src/db.js";
import { recoverOriginalGoaCo } from "../src/dispatch-co-recovery.js";

const apply = process.argv.slice(2).includes("--apply");
const requestedBy = process.env.DISPATCH_CO_RECOVERY_ACTOR || "recover-co-goa-3464-3470-6922";

try {
  const result = await recoverOriginalGoaCo({ apply, requestedBy });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    error: error.message,
    code: error.code || "DISPATCH_CO_RECOVERY_FAILED",
    mismatches: error.mismatches || []
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

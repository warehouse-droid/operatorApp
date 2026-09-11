import fs from "node:fs";
import path from "node:path";
import { closeDb } from "../src/db.js";
import { repairDispatchCoCargo } from "../src/dispatch-co-cargo-repair.js";

const target = {
  planId: "310", planDate: "2026-09-04", coRef: "CO-GOA-7453-7455", sourceOrderRef: "GOA-7453-7455",
  loadId: "T4-L1788581352764-2a46c025e1ae78", driverLogin: "li", fromYard: "2967", toYard: "12441",
  lines: [
    { id: 504, line_id: 4829037, item_id: 4775, quantity: 559.68, pallet_qty: 6 },
    { id: 505, line_id: 4829081, item_id: 1784, quantity: 6, pallet_qty: 0 }
  ]
};
const [mode = "dry-run", backupPath, revision, fingerprint] = process.argv.slice(2);
if (!["dry-run", "apply"].includes(mode) || !backupPath) {
  throw new Error("Usage: node tools/dispatch-co-cargo-repair.mjs dry-run|apply BACKUP_PATH [REVISION FINGERPRINT]");
}
try {
  const dry = await repairDispatchCoCargo({ target });
  // Exclusive, private, pre-write backup. Never overwrite an earlier backup.
  fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(backupPath, JSON.stringify(dry.backup), { flag: "wx", mode: 0o600 });
  const result = mode === "apply"
    ? await repairDispatchCoCargo({ target, apply: true, expectedRevision: revision, expectedFingerprint: fingerprint })
    : dry;
  const { backup: _backup, ...summary } = result;
  console.log(JSON.stringify({ ...summary, backupPath }));
} finally {
  await closeDb();
}

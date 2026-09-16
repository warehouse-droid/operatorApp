import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pool, closeDb } from "../src/db.js";
import { readTransferCleanupState } from "./to-cleanup-repository.mjs";
import { createConflictManifest, conflictSummary, applyConflictManifest, digest } from "./to-conflict-repository.mjs";
const [mode, directory, expectedHash] = process.argv.slice(2);
assert(["plan", "apply", "rollback", "verify"].includes(mode) && directory);
if (["plan", "verify"].includes(mode)) {pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=60000";}
const read = name => JSON.parse(readFileSync(`${directory}/${name}`, "utf8"));
const write = (name, value) => writeFileSync(`${directory}/${name}`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
try {
  if (mode === "plan") {
    const state = await readTransferCleanupState(), manifest = createConflictManifest(state, read("netsuite-details.json"));
    const summary = { ...conflictSummary(manifest), sha256: digest(manifest), refs: manifest.entries.map(entry => entry.ref) };
    write("before.json", state); write("manifest.json", manifest); write("summary.json", summary);
    console.log(JSON.stringify(summary));
  } else {
    const manifest = read("manifest.json"); assert.equal(digest(manifest), expectedHash, "Explicit reviewed manifest hash required");
    if (mode === "verify") {
      const state = await readTransferCleanupState(), repeated = createConflictManifest(state, manifest.remote), summary = conflictSummary(repeated);
      assert.equal(summary.changedOrders, 0); assert.equal(summary.orders, manifest.entries.length);
      write("after.json", state); write("verification.json", { ...summary, verifiedAt: new Date().toISOString() });
      console.log(JSON.stringify(summary));
    } else {
      const result = await applyConflictManifest(manifest, { rollback: mode === "rollback" });
      write(`${mode}-result.json`, result); console.log(JSON.stringify(result));
    }
  }
} finally { await closeDb(); }

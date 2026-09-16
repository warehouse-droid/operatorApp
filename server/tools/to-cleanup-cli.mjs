import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { closeDb, pool } from "../src/db.js";
import { readTransferCleanupState, createTransferCleanupManifest, transferCleanupSummary, applyTransferCleanupManifest, digest } from "./to-cleanup-repository.mjs";
const [mode, directory, expectedHash] = process.argv.slice(2);
assert(["plan", "apply", "rollback", "verify"].includes(mode)); assert(directory);
if (["plan", "verify"].includes(mode)) {pool.options.options = "-c default_transaction_read_only=on -c statement_timeout=60000 -c jit=off";}
const dir = path.resolve(directory); mkdirSync(dir, { recursive: true });
const read = name => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const write = (name, value) => writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
try {
  if (mode === "plan") {
    const state = await readTransferCleanupState(), manifest = createTransferCleanupManifest(state, read("netsuite-statuses.json"));
    write("before.json", state); write("manifest.json", manifest);
    const summary = { ...transferCleanupSummary(manifest), sha256: digest(manifest), heldOrders: manifest.held, excludedOrders: manifest.unchanged };
    write("summary.json", summary); console.log(JSON.stringify(summary));
  } else {
    const manifest = read("manifest.json"); assert.equal(digest(manifest), expectedHash, "Explicit reviewed manifest hash required");
    if (mode === "verify") {
      const state = await readTransferCleanupState();
      const repeated = createTransferCleanupManifest(state, manifest.remote, { candidateIds: manifest.entries.map(entry => entry.id) });
      const summary = transferCleanupSummary(repeated);
      assert.equal(repeated.entries.length, manifest.entries.length); assert.equal(summary.changedOrders, 0);
      write("after.json", state); write("verification.json", { ...summary, verifiedAt: new Date().toISOString() }); console.log(JSON.stringify(summary));
    } else {
      const result = await applyTransferCleanupManifest(manifest, { rollback: mode === "rollback" });
      write(`${mode}-result.json`, result); console.log(JSON.stringify(result));
    }
  }
} finally { await closeDb(); }

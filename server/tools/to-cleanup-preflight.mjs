// Read-only freshness check while isolated tests are running. The apply tool
// repeats these checks under locks before making any mutation.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pool, closeDb } from "../src/db.js";
import { readTransferCleanupState, createTransferCleanupManifest, digest } from "./to-cleanup-repository.mjs";

pool.options.options = "-c default_transaction_read_only=on -c jit=off -c statement_timeout=60000";
const [directory, hash] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(`${directory}/manifest.json`, "utf8"));
assert.equal(digest(manifest), hash);
try {
  const state = await readTransferCleanupState();
  const fresh = createTransferCleanupManifest(state, manifest.remote, { candidateIds: manifest.entries.map(entry => entry.id) });
  const current = new Map(fresh.entries.map(entry => [entry.id, entry]));
  const stale = [];
  for (const entry of manifest.entries) {
    const now = current.get(entry.id), reasons = [];
    if (!now) reasons.push("eligibility changed");
    else {
      if (digest(now.guard) !== digest(entry.guard)) reasons.push("supporting evidence changed");
      if (digest(now.after) !== digest(entry.after)) reasons.push("projected result changed");
      if (![digest(entry.before), digest(entry.after)].includes(digest(now.before))) reasons.push("before-image changed");
    }
    if (reasons.length) stale.push({ ref: entry.ref, reasons });
  }
  const report = { checkedAt: new Date().toISOString(), manifestSha256: hash, candidates: manifest.entries.length, stale };
  writeFileSync(`${directory}/preflight.json`, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
} finally { await closeDb(); }

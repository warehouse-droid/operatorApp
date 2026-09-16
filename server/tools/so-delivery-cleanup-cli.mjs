import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { closeDb } from "../src/db.js";
import { readCleanupState, createCleanupManifest, cleanupManifestSummary, applyCleanupManifest, digest } from "./so-delivery-cleanup-repository.mjs";

const [mode, directory, expectedHash] = process.argv.slice(2);
assert(["plan","rollback","apply","verify"].includes(mode),"Choose plan, rollback, apply, or verify");
assert(directory,"An explicit evidence directory is required");
const dir = path.resolve(directory);
mkdirSync(dir,{recursive:true});
const read = name => JSON.parse(readFileSync(path.join(dir,name),"utf8"));
const write = (name,value) => writeFileSync(path.join(dir,name),`${JSON.stringify(value,null,2)}\n`,{mode:0o600});
try {
  if (mode === "plan") {
    const state = await readCleanupState();
    const scope = expectedHash || "no-local-delivery";
    assert(["no-local-delivery","local-delivery-only"].includes(scope),"Choose a confirmed cleanup scope");
    const manifest = createCleanupManifest(state,read("netsuite-statuses.json"),{scope});
    write("before.json",state);
    write("manifest.json",manifest);
    const summary = {...cleanupManifestSummary(manifest),sha256:digest(manifest),heldOrders:manifest.held};
    write("summary.json",summary);
    console.log(JSON.stringify(summary));
  } else {
    const manifest = read("manifest.json");
    assert.equal(digest(manifest),expectedHash,"The explicit reviewed manifest hash is required and must match");
    if (mode === "verify") {
      const current = await readCleanupState();
      const repeat = createCleanupManifest(current,manifest.remote,{candidateIds:manifest.entries.map(entry => entry.id),
        scope:manifest.scope === "local-delivery-only" ? "local-delivery-only" : "all-qualifying"});
      const summary = cleanupManifestSummary(repeat);
      assert.equal(summary.changedOrders,0,"Applied cleanup is not idempotent");
      assert.equal(repeat.entries.length,manifest.entries.length,"Applied records gained restrictions");
      write("after.json",current);
      write("verification.json",{...summary,verifiedAt:new Date().toISOString()});
      console.log(JSON.stringify(summary));
    } else {
      const result = await applyCleanupManifest(manifest,{rollback:mode === "rollback"});
      write(`${mode}-result.json`,result);
      console.log(JSON.stringify(result));
    }
  }
} finally { await closeDb(); }

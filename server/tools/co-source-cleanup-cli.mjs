import assert from "node:assert/strict";
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import path from "node:path";
import {closeDb} from "../src/db.js";
import {digest} from "./so-delivery-cleanup-repository.mjs";
import {readCoCleanupState,createCoCleanupManifest,applyCoCleanupManifest} from "./co-source-cleanup-repository.mjs";
const [mode,directory,expectedHash]=process.argv.slice(2),dir=path.resolve(directory);
assert(["plan","apply","rollback","verify"].includes(mode));
const read=name=>JSON.parse(readFileSync(path.join(dir,name),"utf8"));
const write=(name,value)=>writeFileSync(path.join(dir,name),JSON.stringify(value,null,2)+"\n",{mode:0o600});
const skipSourceRefs=["SOB108436","SOB111243","SOA04452","SOA04752","SOM04882","SOB114720","SOA05680","SOB114506","SOA05157","SOB116833","SOM05565","SOR00107","SOM05681"];
try {
  if(mode==="plan") {
    const candidateIds=existsSync(path.join(dir,"co-candidate-ids.json"))?read("co-candidate-ids.json"):null;
    const state=await readCoCleanupState(),manifest=createCoCleanupManifest(state,read("netsuite-statuses.json"),{skipSourceRefs,candidateIds});
    const changes=manifest.entries.filter(entry=>digest(entry.before)!==digest(entry.after));
    write("co-before.json",state);write("co-manifest.json",manifest);
    const summary={eligible:manifest.entries.length,changedCos:changes.length,skipped:manifest.skipped.length,sha256:digest(manifest),
      changes:changes.map(entry=>({ref:entry.ref,source:entry.before.order.source_order_ref,evidence:entry.source})),skippedOrders:manifest.skipped};
    write("co-summary.json",summary);console.log(JSON.stringify(summary));
  } else {
    const manifest=read("co-manifest.json");assert.equal(digest(manifest),expectedHash,"A matching reviewed CO manifest hash is required");
    if(mode==="verify") {
      const state=await readCoCleanupState(),fresh=createCoCleanupManifest(state,manifest.remote,{candidateIds:manifest.entries.map(entry=>entry.id),skipSourceRefs:manifest.skipSourceRefs});
      assert.equal(fresh.entries.length,manifest.entries.length);
      assert(fresh.entries.every(entry=>digest(entry.before)===digest(entry.after)),"CO cleanup is not idempotent");
      write("co-after.json",state);console.log(JSON.stringify({verified:fresh.entries.length,remainingChanges:0}));
    } else {const result=await applyCoCleanupManifest(manifest,{rollback:mode==="rollback"});write(`co-${mode}-result.json`,result);console.log(JSON.stringify(result));}
  }
} finally {await closeDb();}

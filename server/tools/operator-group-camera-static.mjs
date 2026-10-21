import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
const base = "test-artifacts/operator-group-camera";
const files = {"public/operator.js":"operator.before.js", "src/delivery-repository.js":"delivery.before.js",
  "public/i18n.js":"i18n.before.js", "public/service-worker.js":"service-worker.before.js"};
const lint = new ESLint({overrideConfigFile:"tools/consolidation-load-eslint.config.mjs"});
const diagnostics = rows => rows.flatMap(row => row.messages.map(({ruleId,message,severity}) => JSON.stringify({ruleId,message,severity}))).sort();
const results = [];
for (const [file,before] of Object.entries(files)) {
  const syntax = spawnSync(process.execPath,["--check",file],{encoding:"utf8"});
  assert.equal(syntax.status,0,syntax.stderr);
  const old = diagnostics(await lint.lintText(readFileSync(`${base}/${before}`,"utf8"),{filePath:file}));
  const next = diagnostics(await lint.lintText(readFileSync(file,"utf8"),{filePath:file}));
  const remaining = [...old], added = [];
  for (const item of next) { const index = remaining.indexOf(item); if(index >= 0) remaining.splice(index,1); else added.push(item); }
  results.push({file,baseline:old.length,current:next.length,added});
}
writeFileSync(`${base}/static.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
assert(results.every(row => row.added.length === 0),"New lint diagnostics");
const html=readFileSync("public/operator.html","utf8"), sw=readFileSync("public/service-worker.js","utf8");
for(const asset of ["operator.js","i18n.js","operator.css"]) {
  const version = html.match(new RegExp(`/${asset.replace(".","\\.")}\\?v=([^"\\s]+)`))[0];
  assert(sw.includes(version),`${asset} service-worker entry must match the page`);
}
console.log("Syntax, baseline lint comparison and asset versions passed.");

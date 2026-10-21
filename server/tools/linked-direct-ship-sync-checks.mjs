import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const artifact="test-artifacts/linked-direct-ship-sync";
const checks={};
function run(name,args){
  const result=spawnSync(process.execPath,args,{encoding:"utf8",timeout:180000});
  writeFileSync(`${artifact}/${name}-final.log`,result.stdout+result.stderr);
  checks[name]={exit:result.status};
  console.log(JSON.stringify({check:name,exit:result.status}));
  if(result.status!==0){process.stderr.write((result.stdout+result.stderr).slice(-7000));}
  assert.equal(result.status,0,name);
  return result.stdout;
}
const tests=["test/mbt/unit/linked-direct-ship-sync.test.js","test/mbt/integration/linked-direct-ship-sync.test.js",
  "test/mbt/integration/direct-to-completion.test.js","test/mbt/integration/operator-linked-quantity-repository.red.test.js",
  "test/dispatch/integration/order-dependency-multi-to-extension.red.test.js","test/dispatch/integration/order-dependency-quantity-replay.red.test.js",
  "test/mbt/integration/link-to-group.test.js","test/mbt/integration/retired-group-dependency.test.js",
  "test/dispatch/integration/to-dependency-packing-independent.test.js","test/dispatch/integration/scm-dependency-change-request.red.test.js",
  "test/mbt/integration/to-linked-so-completion.test.js","test/mbt/integration/operator-direct-orderline.test.js",
  "test/dispatch/property/order-dependency-quantity.property.test.js","test/mbt/unit/operator-linked-fulfillment.red.test.js",
  "test/mbt/unit/operator-linked-fulfillment-ui.red.test.js"];
const files=["src/linked-direct-ship-sync-domain.js","src/linked-direct-ship-sync-repository.js","src/order-sync-repository.js",
  "src/order-dependency-repository.js","src/direct-to-completion-repository.js","migrations/286_linked_direct_ship_quantity_sync.sql"];
const sourceHashes=Object.fromEntries(files.map(file=>[file,createHash("sha256").update(readFileSync(file)).digest("hex")]));
writeFileSync(`${artifact}/source-state.json`,JSON.stringify(sourceHashes,null,2)+"\n");
run("tests",["--test","--test-concurrency=1",...tests]);
run("coverage",["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false",...files.filter(file=>file.endsWith(".js")).map(file=>`--include=${file}`),
  "--temp-directory=/tmp/direct-ship-final-c8",`--report-dir=${artifact}/coverage`,"--reporter=json","--reporter=json-summary","--reporter=text-summary",
  "node","--test","--test-concurrency=1",...tests.slice(0,8)]);
run("types",["node_modules/typescript/bin/tsc","--allowJs","--checkJs","false","--noEmit","--strict","--skipLibCheck","--module","NodeNext",
  "--target","ES2023","src/linked-direct-ship-sync-domain.js","src/linked-direct-ship-sync-repository.js"]);
run("lint",["node_modules/eslint/bin/eslint.js","--config","tools/linked-direct-ship-sync-eslint.config.mjs","--max-warnings=0",
  ...files.slice(0,2),...tests.slice(0,2),"tools/linked-direct-ship-sync-checks.mjs","tools/linked-direct-ship-sync-mutations.mjs"]);
run("mutation",["tools/linked-direct-ship-sync-mutations.mjs"]);
run("reordered",["--test","--test-concurrency=1",...tests.slice(0,8).reverse()]);
run("secrets",["test/support/scan-diff-secrets.mjs",...files,...tests.slice(0,2),"tools/linked-direct-ship-sync-checks.mjs",
  "tools/linked-direct-ship-sync-mutations.mjs","tools/linked-direct-ship-sync-test.sh"]);
for(const [file,hash]of Object.entries(sourceHashes)){assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"),hash);}
const versions=Object.fromEntries(["c8","eslint","fast-check","typescript","pg"].map(name=>[name,JSON.parse(readFileSync(`node_modules/${name}/package.json`)).version]));
writeFileSync(`${artifact}/checks.json`,JSON.stringify({checks,sourceHashes,versions,node:process.version,tests},null,2)+"\n");

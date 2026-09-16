import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {writeFileSync} from "node:fs";
const directory="test-artifacts/so-delivery-cleanup-grouped-co-20260915";
const run=(name,args)=>{
  const result=spawnSync(process.execPath,args,{encoding:"utf8",maxBuffer:20*1024*1024});
  writeFileSync(`${directory}/${name}.log`,result.stdout+result.stderr);
  assert.equal(result.status,0,`${name} failed; see ${directory}/${name}.log`);
};
run("focused",["--test","--test-concurrency=1","test/dispatch/unit/co-source-group-cleanup.test.js",
  "test/dispatch/unit/co-source-cleanup.test.js","test/dispatch/unit/local-co-loaded.test.js",
  "test/dispatch/integration/co-source-cleanup.test.js","test/dispatch/integration/so-delivery-cleanup.test.js",
  "test/dispatch/unit/dispatch-fulfilled-so-policy.test.js"]);
run("mutations",["tools/co-source-group-cleanup-mutations.mjs"]);
run("lint",["node_modules/eslint/bin/eslint.js","--config","tools/so-delivery-cleanup-eslint.config.mjs",
  "tools/co-source-cleanup-repository.mjs","tools/co-source-cleanup-cli.mjs",
  "tools/co-source-group-cleanup-rehearse.mjs","tools/co-source-group-cleanup-mutations.mjs"]);
run("rehearsal",["tools/co-source-group-cleanup-rehearse.mjs"]);
run("coverage",["node_modules/c8/bin/c8.js","report","--all=false","--check-coverage=false",
  `--temp-directory=${directory}/coverage`,`--reports-dir=${directory}/c8`,
  "--include=tools/co-source-cleanup-repository.mjs","--reporter=json","--reporter=json-summary","--reporter=text"]);
console.log("Grouped CO tests, fault injection, lint and captured-data rehearsal passed.");

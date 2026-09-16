import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import {ESLint} from "eslint";
import {files,focused,runNode} from "./split-inbound-completion-suite.mjs";
import base from "../eslint.mbt.config.js";
import {scanPaths} from "../test/support/scan-diff-secrets.mjs";

const artifact="test-artifacts/split-inbound-completion";
const hashes=Object.fromEntries(files.map(file=>[file,crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));
for(const file of files.filter(file=>file.endsWith(".js"))) {
  const result=runNode(["--check",file]);
  if(result.status)throw new Error(result.output);
}
const eslint=new ESLint({overrideConfigFile:true,overrideConfig:[{
  files:["**/*.{js,mjs}"],languageOptions:base[0].languageOptions,
  rules:{"no-undef":"error","no-unused-vars":["error",{argsIgnorePattern:"^_",varsIgnorePattern:"^smart"}],"no-unreachable":"error","eqeqeq":"error","no-var":"error"}
}]});
const lint=[];
for(const file of files) {
  const before=(await eslint.lintText(fs.readFileSync(`${artifact}/baseline/${file}`,"utf8"),{filePath:file}))[0];
  const after=(await eslint.lintFiles(file))[0];
  const counts=rows=>rows.messages.reduce((map,m)=>{const k=`${m.ruleId}:${m.message}`;map[k]=(map[k]||0)+1;return map;},{});
  const old=counts(before),current=counts(after);
  const added=Object.keys(current).filter(k=>current[k]>(old[k]||0));
  lint.push({file,baseline:before.messages.length,current:after.messages.length,added});
  assert.deepEqual(added,[],JSON.stringify(lint.at(-1)));
}
const complexity=new ESLint({overrideConfigFile:true,overrideConfig:[{files:["**/*.js"],rules:{complexity:["error",12]}}]});
const complexityMessages=(await complexity.lintFiles(files[0]))[0].messages;
assert.deepEqual(complexityMessages,[]);
const secrets=await scanPaths([files[0],...focused,"test/support/split-inbound-completion-fixture.mjs"]);
assert.deepEqual(secrets,[]);
fs.writeFileSync(`${artifact}/static.json`,JSON.stringify({node:process.version,hashes,lint,complexityMessages,secrets},null,2));
const coverage=runNode(["node_modules/c8/bin/c8.js","--all=false","--check-coverage=false","--reporter=json","--reporter=json-summary",`--report-dir=${artifact}/coverage`,"--include=src/*.js",
  "node","--test","--test-concurrency=1",...focused],{log:`${artifact}/coverage.log`});
if(coverage.status)throw new Error(coverage.output);
console.log(JSON.stringify({syntax:"passed",lint,complexity:"new helper <= 12",coverage:"captured",hashes}));

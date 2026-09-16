import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scanTextForSecrets } from "../test/support/scan-diff-secrets.mjs";

assert.equal(process.env.MBT_TEST_ISOLATED,"1");
const folder="test-artifacts/sn1400625-receiving";
const runtime="src/operator-netsuite-posting-targets.js";
const testFile="test/mbt/integration/sn1400625-receiving.test.js";
const filter="          AND COALESCE(line.netsuite_active, true) = true\n";
const current=readFileSync(runtime,"utf8");
assert.equal(current.split(filter).length,2);
const hash=source=>createHash("sha256").update(source).digest("hex");
mkdirSync(folder,{recursive:true});
const results=[];

function run(name,command,args,{cwd=process.cwd(),accept}={}) {
  const result=spawnSync(command,args,{cwd,encoding:"utf8",maxBuffer:100e6});
  assert.ifError(result.error);
  const output=`${result.stdout}${result.stderr}`;
  writeFileSync(`${folder}/${name}.log`,output);
  const accepted=accept ? accept(result,output) : result.status===0;
  results.push({name,exitCode:result.status,accepted});
  writeFileSync(`${folder}/checks.json`,JSON.stringify(results,null,2));
  console.log(JSON.stringify(results.at(-1)));
  assert.ok(accepted,`${name} failed: ${folder}/${name}.log`);
  return output;
}

function sourceCopy(source) {
  const root=mkdtempSync(path.join(tmpdir(),"sn1400625-"));
  for (const directory of ["src","public","test","tools","migrations","contracts"]) {
    cpSync(directory,path.join(root,directory),{recursive:true});
  }
  for (const file of ["package.json","tsconfig.mbt.json","eslint.mbt.config.js"]) {
    cpSync(file,path.join(root,file));
  }
  symlinkSync(path.resolve("node_modules"),path.join(root,"node_modules"),"dir");
  writeFileSync(path.join(root,runtime),source);
  return root;
}

function failures(output) {
  return [...new Set([...output.matchAll(/^(?:not ok \d+ - |✖ )(.+?)(?: \([\d.]+ms\))?$/gm)]
    .map(match=>match[1]).filter(name=>name!=="failing tests:"))].sort();
}

const baseline=sourceCopy(current.replace(filter,""));
try {
  if (process.argv.includes("--baseline-full")) {
    rmSync(path.join(baseline,testFile));
    run("baseline-full","npm",["test"],{cwd:baseline,accept:result=>result.status<=1});
    process.exit(0);
  }
  if (process.argv.includes("--full")) {
    run("full","npm",["test"],{accept:result=>result.status<=1});
    process.exit(0);
  }
  const tests=[testFile,"test/mbt/unit/operator-netsuite-posting-targets.red.test.js",
    "test/mbt/unit/operator-netsuite-posting-domain.red.test.js","test/mbt/unit/sn1400333-receiving.test.js",
    "test/mbt/unit/operator-netsuite-posting-service.red.test.js","test/mbt/unit/operator-netsuite-posting-admission.red.test.js",
    "test/mbt/unit/operator-netsuite-posting-runtime-adapters.red.test.js",
    "test/mbt/adversarial/operator-netsuite-posting-adversarial.test.js",
    "test/mbt/property/operator-netsuite-posting.property.test.js",
    "test/mbt/integration/operator-receiving-allocations.test.js"];
  run("focused",process.execPath,["--test","--test-concurrency=1",...tests]);
  const shuffled=[...tests].sort((left,right)=>hash(`1400625:${left}`).localeCompare(hash(`1400625:${right}`)));
  for (const [index,file] of shuffled.entries()) {
    run(`shuffled-${index+1}`,process.execPath,["--test",file]);
  }
  for (const name of ["coverage","c8"]) { rmSync(`${folder}/${name}`,{recursive:true,force:true}); }
  run("coverage","node_modules/.bin/c8",["--all=false","--check-coverage=false",`--include=${runtime}`,
    `--temp-directory=${folder}/c8`,`--report-dir=${folder}/coverage`,"--reporter=json","--reporter=text",
    process.execPath,"--test","--test-concurrency=1",...tests]);
  const coverage=Object.values(JSON.parse(readFileSync(`${folder}/coverage/coverage-final.json`,"utf8")))
    .find(report=>report.path.endsWith(`/${runtime}`));
  const line=current.slice(0,current.indexOf(filter)).split("\n").length;
  const count=Math.max(0,...Object.entries(coverage.statementMap)
    .filter(([,range])=>range.start.line<=line && range.end.line>=line).map(([key])=>coverage.s[key]));
  assert.ok(count>0,"Changed SQL filter must execute in SQL-backed tests");
  const errors=output=>output.split("\n").filter(entry=>/error TS\d+/.test(entry))
    .map(entry=>entry.replace(/\(\d+,\d+\)/,"")).sort();
  const typeArgs=["--project","tsconfig.mbt.json","--noEmit","--pretty","false"];
  const oldTypes=run("types-baseline",path.resolve("node_modules/.bin/tsc"),typeArgs,
    {cwd:baseline,accept:result=>result.status<=2});
  const newTypes=run("types","node_modules/.bin/tsc",typeArgs,{accept:(_result,output)=>{
    assert.deepEqual(errors(output),errors(oldTypes));return true;
  }});
  const files=[runtime,testFile,"tools/sn1400625-receiving-checks.mjs"];
  run("lint","node_modules/.bin/eslint",["--config","eslint.mbt.config.js","--max-warnings=0",...files]);
  for (const file of files) { assert.deepEqual(scanTextForSecrets(readFileSync(file,"utf8"),file),[]); }
  const mutants=[
    ["include deleted history",filter,""],
    ["exclude active source lines",filter,filter.replace("= true","= false")],
    ["skip active parent identity validation","for (const row of rows.rows || []) {","for (const row of []) {"],
    ["allow inactive selected split source","if (mapped.length !== 1) {","if (false) {"]
  ];
  const mutations=[];
  for (const [index,[name,original,replacement]] of mutants.entries()) {
    assert.equal(current.split(original).length,2,name);
    const root=sourceCopy(current.replace(original,replacement));
    try {
      for (const layer of ["focused","property"]) {
        run(`mutant-${index+1}-${layer}`,process.execPath,
          ["--test",...(layer==="property"?["--test-name-pattern=property:"]:[]),testFile],
          {cwd:root,accept:(result,output)=>result.status!==0 && /ERR_ASSERTION|Property failed after|LINE_MAPPING_UNRESOLVED/.test(output)});
        mutations.push({name,layer,killed:true});
      }
    } finally { rmSync(root,{recursive:true,force:true}); }
  }
  run("restored",process.execPath,["--test",testFile]);
  const summary={node:process.version,sourceSha256:hash(current),beforeSha256:hash(current.replace(filter,"")),
    changedLineCoverage:{covered:1,total:1,line,count},typeErrors:{baseline:errors(oldTypes).length,current:errors(newTypes).length},
    shuffledFiles:shuffled,mutations,files:Object.fromEntries(files.map(file=>[file,hash(readFileSync(file))]))};
  if (process.argv.includes("--compare-full")) {
    const previous=failures(readFileSync(`${folder}/baseline-full.log`,"utf8"));
    const latest=failures(readFileSync(`${folder}/full.log`,"utf8"));
    assert.deepEqual(latest,previous);
    summary.fullSuiteFailures=latest;
  }
  writeFileSync(`${folder}/summary.json`,JSON.stringify(summary,null,2));
} finally { rmSync(baseline,{recursive:true,force:true}); }

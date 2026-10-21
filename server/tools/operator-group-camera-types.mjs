import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
const art="test-artifacts/operator-group-camera";
const files={"public/operator.js":"operator.before.js","src/delivery-repository.js":"delivery.before.js"};
const root=mkdtempSync(path.join(tmpdir(),"operator-type-check-"));
for(const name of ["public","src"])mkdirSync(`${root}/${name}`);
symlinkSync(path.resolve("node_modules"),`${root}/node_modules`);
writeFileSync(`${root}/package.json`,'{"type":"module"}');
function diagnostics(baseline) {
  for(const [file,before] of Object.entries(files))writeFileSync(`${root}/${file}`,readFileSync(baseline?`${art}/${before}`:file));
  const run=spawnSync(path.resolve("node_modules/.bin/tsc"),["--ignoreConfig","--allowJs","--checkJs","--noEmit","--noResolve","--skipLibCheck",
    "--target","ES2022","--module","NodeNext",...Object.keys(files)],{cwd:root,encoding:"utf8",maxBuffer:20e6});
  assert(run.status!==null,run.error?.message);
  const output=run.stdout+run.stderr;
  writeFileSync(`${art}/types-${baseline?'before':'after'}.log`,output);
  return output.split("\n").filter(Boolean).map(line=>line.replace(/\(\d+,\d+\)/g,"(LINE,COLUMN)")).sort();
}
const before=diagnostics(true),after=diagnostics(false),remaining=[...before],added=[];
for(const row of after){const at=remaining.indexOf(row);if(at<0)added.push(row);else remaining.splice(at,1);}
const version=spawnSync(path.resolve("node_modules/.bin/tsc"),["--version"],{encoding:"utf8"}).stdout.trim();
const result={version,scope:Object.keys(files),noResolve:true,baseline:before.length,current:after.length,added};
writeFileSync(`${art}/types.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
assert.equal(added.length,0,"New scoped type diagnostics");

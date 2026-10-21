import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,cpSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
const root=mkdtempSync(path.join(tmpdir(),"operator-group-baseline-"));
mkdirSync(`${root}/public`,{recursive:true});mkdirSync(`${root}/test/mbt/unit`,{recursive:true});
mkdirSync(`${root}/src`,{recursive:true});cpSync("public",`${root}/public`,{recursive:true});
copyFileSync("src/server.js",`${root}/src/server.js`);symlinkSync(path.resolve("node_modules"),`${root}/node_modules`);
writeFileSync(`${root}/package.json`,'{"type":"module"}');
for(const [from,to] of [["operator.before.js","operator.js"],["operator.before.html","operator.html"],["service-worker.before.js","service-worker.js"]])
  copyFileSync(`test-artifacts/operator-group-camera/${from}`,`${root}/public/${to}`);
const browser=process.argv[2]==="browser";
const files=browser?["test/dispatch/frontend/consolidation-load.browser.test.mjs"]:
  ["test/mbt/unit/operator-page-confirm-ui.contract.test.js","test/mbt/unit/operator-delivery-refresh.test.js"];
for(const file of files){mkdirSync(path.dirname(`${root}/${file}`),{recursive:true});copyFileSync(file,`${root}/${file}`);}
const result=spawnSync(process.execPath,["--test",...files],{cwd:root,encoding:"utf8",timeout:120000});
writeFileSync(`test-artifacts/operator-group-camera/${browser?'consolidation':'legacy-cache'}-baseline.log`,result.stdout+result.stderr);
console.log(result.stdout);process.exitCode=result.status;

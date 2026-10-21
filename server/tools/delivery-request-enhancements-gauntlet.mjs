import {spawnSync} from 'node:child_process';
import {rmSync,readFileSync,writeFileSync} from 'node:fs';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Use the disposable Compose test runner.');}
for(const path of ['test-artifacts/coverage','test-artifacts/mutations']) {rmSync(path,{recursive:true,force:true});}
const layers=[];
for(const [name,tool] of [['tests-types-lint','checks'],['mutation','mutations'],['coverage','coverage']]) {
  const result=spawnSync(process.execPath,[`tools/delivery-request-enhancements-${tool}.mjs`],{stdio:'inherit'});
  layers.push({name,exitCode:result.status});writeFileSync('test-artifacts/layers.json',JSON.stringify(layers,null,2)+'\n');
  if(result.status!==0) {process.exit(result.status || 1);}
}
const mutations=JSON.parse(readFileSync('test-artifacts/mutations/results.json'));
writeFileSync('test-artifacts/evidence.json',JSON.stringify({layers,sourceHashes:JSON.parse(readFileSync('test-artifacts/source-hashes.json')),
  coverage:JSON.parse(readFileSync('test-artifacts/changed-lines-coverage.json')),mutations},null,2)+'\n');

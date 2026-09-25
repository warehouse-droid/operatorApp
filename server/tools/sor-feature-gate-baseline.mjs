import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=['test/mbt/unit/feature-gate-catalog.test.js','test/mbt/integration/feature-gate-admin-http.test.js'];
const paths=files.map((file,index)=>{
 const path=`/tmp/sor-gate-baseline-${index}.mjs`;
 writeFileSync(path,readFileSync(file,'utf8').replace(/^\s*"sor_rental_workflow",\n/m,'').replace('MBT_ADMIN_GATE_KEYS.slice(0, 38)','MBT_ADMIN_GATE_KEYS.slice(0, 37)').replaceAll('../../../src/','/app/src/'));
 return path;
});
process.exitCode=spawnSync('node',['--test','--test-concurrency=1',...paths],{stdio:'inherit'}).status;

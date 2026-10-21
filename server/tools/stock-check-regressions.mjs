import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
if(process.env.MBT_TEST_ISOLATED!=='1') {throw new Error('Use the isolated Stock Check test runner.');}
const files=[];
async function visit(dir) {
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    const target=path.join(dir,entry.name);
    if(entry.isDirectory()) {await visit(target);}else if(/\.test\.(js|mjs)$/u.test(entry.name)&&!entry.name.startsWith('stock-check')) {files.push(target);}
  }
}
for(const group of ['infrastructure','unit','contracts','property','integration','adversarial','concurrency']) {await visit('test/mbt/'+group);}
files.sort();
if(process.argv[2]) {
  const requested=process.argv[2];if(!files.includes(requested)) {throw new Error('Select an existing MBT regression file.');}
  files.splice(0,files.length,requested);
}
console.log('Stock Check regression files: '+files.length);
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'stock-check-regression-runner-'));
try {
  await fs.symlink(path.join(process.cwd(),'node_modules'),path.join(temporary,'node_modules'));
  let helper=await fs.readFile('test/support/test-database-isolation.mjs','utf8');
  const options='env: environment,\n      stdio:';
  if(!helper.includes(options)) {throw new Error('Regression runner changed; review its timeout wrapper.');}
  helper=helper.replace(options,'env: environment,\n      detached: true,\n      stdio:');
  helper=helper.replace('let stdout = "";','const deadline=setTimeout(()=>{process.stderr.write("REGRESSION_TIMEOUT "+file+"\\n");try {process.kill(-child.pid,"SIGKILL");} catch {}},90000);\n    let stdout = "";');
  helper=helper.replace('child.once("exit", (code, signal) => {','child.once("exit", (code, signal) => {\n      clearTimeout(deadline);');
  const filename=path.join(temporary,'isolation.mjs');await fs.writeFile(filename,helper);
  const {runNodeTestFilesIsolated}=await import(pathToFileURL(filename));
  process.exitCode=await runNodeTestFilesIsolated(files,{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Stock Check regressions'});
} finally {await fs.rm(temporary,{recursive:true,force:true});}

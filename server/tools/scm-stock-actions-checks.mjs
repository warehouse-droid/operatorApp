import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const files=process.argv.slice(2).length?process.argv.slice(2):JSON.parse(readFileSync('tools/scm-stock-actions-suites.json','utf8'));
if(!process.argv.slice(2).length){const check=spawnSync(process.execPath,['tools/scm-stock-actions-static.mjs'],{stdio:'inherit'});if(check.status)process.exit(check.status);}
process.exitCode=await runNodeTestFilesIsolated(files.map(name=>new URL('../test/mbt/'+name,import.meta.url).pathname),{
  environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'SCM stock actions'});

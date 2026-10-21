import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildIsolatedTestEnvironment } from '../test/support/test-foundation.mjs';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

assert.equal(process.env.MBT_TEST_ISOLATED,'1');
const files=JSON.parse(readFileSync('test/receiving-multi-yard-focused-tests.json','utf8')).map(file=>path.resolve(file));
if(process.argv.includes('--reverse')) {files.reverse();}
const environment=buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL});
process.exitCode=await runNodeTestFilesIsolated(files,{environment,label:'Receiving multi-yard'});

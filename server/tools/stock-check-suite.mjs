import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
import {buildIsolatedTestEnvironment} from '../test/support/test-foundation.mjs';
const files=process.argv.slice(2);
process.exitCode=await runNodeTestFilesIsolated(files,{environment:buildIsolatedTestEnvironment(process.env,{databaseUrl:process.env.DATABASE_URL}),label:'Stock Check'});

import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const files=process.argv.slice(2);
if(!files.length || files.some(f=>!/^test\/mbt\/(unit|integration|property|concurrency)\/[\w.-]+\.test\.js$/.test(f))) throw new Error('Explicit receipt regression files required');
process.exitCode=await runNodeTestFilesIsolated(files,{label:'mbt-uat',environment:{...process.env,NODE_OPTIONS:`${process.env.NODE_OPTIONS||''} --require=/app/tools/bin-order-workflow-browser-env.cjs`}});

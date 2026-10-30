import {readdirSync} from 'node:fs';
import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
const red=process.argv.includes('--red'),files=red?[
  'test/mbt/integration/bin-transport-errors.test.js',
  'test/mbt/integration/bin-transport-errors-browser.test.js'
]:['test/mbt/unit/pure-contracts.test.js'];
if(!red) for(const dir of ['unit','integration','property']) {
  for(const name of readdirSync(`test/mbt/${dir}`).sort()) {
    if(name.endsWith('.test.js') && /^(bin-transport|aggregate-routing)/u.test(name)) files.push(`test/mbt/${dir}/${name}`);
  }
}
if(process.env.BIN_PLANNING_REVERSE==='1') files.reverse();
process.exitCode=await runNodeTestFilesIsolated(files,{label:'transport-errors',environment:{...process.env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});

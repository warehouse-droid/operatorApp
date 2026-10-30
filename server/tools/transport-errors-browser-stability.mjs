import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
for(let attempt=1;attempt<=3;attempt++) {
  const result=await runNodeTestFilesIsolated(['test/mbt/integration/bin-transport-errors-browser.test.js'],
    {label:`transport-errors-repeat-${attempt}`,environment:{...process.env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
  if(result) {process.exitCode=result;break;}
}

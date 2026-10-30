import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
for(let attempt=1;attempt<=3;attempt++) {
  const result=await runNodeTestFilesIsolated(['test/mbt/integration/bin-weight-warning-browser.test.js'],
    {label:`bin-weight-warning-repeat-${attempt}`,environment:{...process.env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
  if(result) {process.exitCode=result;break;}
}

import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
for(let attempt=1;attempt<=5;attempt++) {
  const result=await runNodeTestFilesIsolated(['test/mbt/integration/bin-linked-delivery-browser.test.js',
    'test/mbt/integration/bin-planning-browser.test.js'],
    {label:`planning-browser-repeat-${attempt}`,environment:{...process.env,NODE_OPTIONS:'--require=/app/tools/bin-order-workflow-browser-env.cjs'}});
  if(result) {process.exitCode=result;break;}
}

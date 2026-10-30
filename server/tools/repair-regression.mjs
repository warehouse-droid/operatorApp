import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Disposable test runner required.');
const files=['test/mbr/domain.test.js','test/mbr/http.test.js','test/mbr/runtime.test.js','test/mbt/integration/authority-roles.test.js','test/mbt/integration/driver-bin-execution.test.js','test/mbt/integration/driver-plan-date-execution-repository.test.js','test/mbt/unit/driver-plan-date-execution.red.test.js','test/mbt/property/driver-plan-date-execution.property.test.js','test/mbt/adversarial/driver-plan-date-execution-adversarial.test.js'];
process.exitCode=await runNodeTestFilesIsolated(files,{label:'Repair affected regression',environment:{...process.env,MBR_CONTRACTS_ENABLED:'true'}});

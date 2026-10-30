import {runNodeTestFilesIsolated} from '../test/support/test-database-isolation.mjs';
await import('./repair-gauntlet.mjs');
const code=await runNodeTestFilesIsolated(['test/mbt/integration/staff-login-browser.test.js','test/mbt/integration/menu-order-browser.test.js','test/mbt/integration/app-notifications-browser.test.js'],{label:'Repair office shared-shell regressions',environment:{...process.env,MBR_CONTRACTS_ENABLED:'true'}});
console.log(JSON.stringify({name:'office-shared-shell-regressions',code}));
process.exitCode=code;

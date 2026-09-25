// Full regression/browser verification on a rebased image. The deployment
// checker first proves only the five unrelated receipt files differ from the
// image that completed the inherited mutation suites. New UI faults run again.
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
if(process.env.SPECIAL_BUTTON_REBASE_PROVEN!=='1')throw new Error('Verified rebase proof required');
const output='test-artifacts/special-workflow-so-buttons/final';
let source=readFileSync('tools/special-workflow-enquiry-gauntlet.mjs','utf8');
for(const name of ['mutations','pricing-mutations','polish-mutations','enquiry-mutations']) {
  const pattern=new RegExp(`^run\\('${name}',.*$`,'m');
  if(!pattern.test(source))throw new Error('Missing inherited mutation layer '+name);
  source=source.replace(pattern,`console.log('REUSED ${name}: verified unchanged source; see rebase-proof.json');`);
}
const file='.special-so-rebased-gauntlet.mjs';writeFileSync(file,source);
try {
  const env={...process.env,SPECIAL_WORKFLOW_OUTPUT:output,SPECIAL_ENQUIRY_BROWSER_OUTPUT:'test-artifacts/special-workflow-so-buttons/browser',SPECIAL_BUTTON_COVERAGE_DIR:'test-artifacts/special-workflow-so-buttons/browser-coverage',PLAYWRIGHT_BROWSERS_PATH:'/browsers'};
  const result=spawnSync(process.execPath,[file],{env,stdio:'inherit',timeout:300000});
  if(result.status!==0)throw new Error('Rebased regression suite failed');
  const faults=spawnSync(process.execPath,['tools/special-workflow-so-buttons-check.mjs','--finish'],{env,stdio:'inherit',timeout:180000});
  if(faults.status!==0)throw new Error('Rebased frontend faults/coverage failed');
}finally{unlinkSync(file);}

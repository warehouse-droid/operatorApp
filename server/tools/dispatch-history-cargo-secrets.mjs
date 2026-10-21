import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {scanPaths,scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';

const root=process.env.DISPATCH_CARGO_GAUNTLET_DIRECTORY || 'test-artifacts/dispatch-all-history-20261002/cargo-route';
const files=[
  'src/dispatch-retained-link-manifests.js',
  'test/dispatch/unit/linked-stop-cargo.test.js','test/dispatch/integration/linked-driver-stop-content.test.js',
  ...(await readdir('tools')).filter(name=>name.startsWith('dispatch-history-cargo-')).map(name=>`tools/${name}`)
];
const findings=[...await scanPaths(files),...scanUnifiedDiff(await readFile(`${root}/changes.patch`,'utf8'))];
const versions=Object.fromEntries(await Promise.all(['pg','c8','eslint','typescript','fast-check','@playwright/test'].map(async name=>
  [name,JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version])));
const report={completedAt:new Date().toISOString(),files,findings,
  versions:{node:process.version,v8:process.versions.v8,...versions},
  dependencies:'No packages added or upgraded for this task; existing pinned test-image tools used.',
  productionCapabilities:'New production imports are local pure helpers. No new external network, subprocess, filesystem or environment access.',
  verificationCapabilities:'Verification tools read saved fixtures, create disposable source copies and run tests inside the existing isolated environment.'};
await writeFile(`${root}/secrets.json`,JSON.stringify(report,null,2)+'\n',{mode:0o600});
assert.equal(findings.length,0,'Unreviewed potential secrets found');
console.log(JSON.stringify({files:files.length,findings:findings.length,versions:report.versions}));

import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {scanPaths,scanUnifiedDiff} from '../test/support/scan-diff-secrets.mjs';
const directory='test-artifacts/boss-approvals';
const files=[...(await readdir('src')).filter(name=>name.startsWith('boss-approval-')||name==='account-email.js').map(name=>'src/'+name),
 'public/boss.js','public/boss-admin.js','migrations/261_boss_approvals.sql'];
const findings=[...await scanPaths(files),...scanUnifiedDiff(await readFile('/workspace/'+directory+'/task.diff','utf8'))];
const versions={node:process.version};
for(const name of ['pg','c8','eslint','typescript','fast-check','playwright']){versions[name]=JSON.parse(await readFile(`node_modules/${name}/package.json`,'utf8')).version;}
versions.nodemailer=JSON.parse(await readFile('/workspace/node_modules/nodemailer/package.json','utf8')).version;
await writeFile(`${directory}/secrets.json`,JSON.stringify({files,findings,versions,capabilities:'Adds authenticated NetSuite Sales Order PATCH/read-back, TLS SMTP delivery and BOSS_SMTP_* environment settings. No new production subprocess or filesystem writes.'},null,2));
process.stdout.write(JSON.stringify({findings,versions},null,2)+'\n');assert.equal(findings.length,0,'Review secret scanner findings');

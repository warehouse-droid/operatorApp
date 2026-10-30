import fs from 'node:fs/promises';
if(process.env.MBT_TEST_ISOLATED!=='1')throw new Error('Use the disposable Repair runner.');
const coverage=JSON.parse(await fs.readFile('/app/test-artifacts/repair-gauntlet/coverage/coverage-final.json','utf8'));
const patch=await fs.readFile('/app/test-artifacts/repair-integration.diff','utf8'),changed=new Map();let file='',line=0;
for(const text of patch.split('\n')){if(text.startsWith('+++ candidate/')){file=text.slice(14);changed.set(file,new Set());}else if(text.startsWith('@@'))line=Number(text.match(/\+(\d+)/u)[1]);else if(text.startsWith('+')&&!text.startsWith('+++')){changed.get(file)?.add(line++);}else if(text.startsWith(' '))line++;}
const rows=[];let total=0,covered=0;
for(const [name,lines] of changed){const item=coverage['/app/'+name];if(!item)continue;const hits=new Map();for(const [id,statement] of Object.entries(item.statementMap))for(let n=statement.start.line;n<=statement.end.line;n++)hits.set(n,Math.max(hits.get(n)||0,item.s[id]));const executable=[...lines].filter(n=>hits.has(n)),missing=executable.filter(n=>!hits.get(n));total+=executable.length;covered+=executable.length-missing.length;rows.push({file:name,changedExecutableLines:executable.length,covered:executable.length-missing.length,missing});}
console.log(JSON.stringify({changedBackendDomainCoverage:{total,covered,files:rows,excluded:'Browser JavaScript/CSS/HTML and SQL are exercised by browser and migration tests; this report instruments imported Node backend/shared-domain JavaScript only.'}}));
if(rows.some(row=>row.missing.length))throw new Error('Review uncovered changed backend/domain lines before release.');

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import v8ToIstanbul from 'v8-to-istanbul';
import coverage from 'istanbul-lib-coverage';

const root='test-artifacts/special-workflow-so-buttons';
const env={...process.env,SPECIAL_WORKFLOW_OUTPUT:`${root}/final`,SPECIAL_ENQUIRY_BROWSER_OUTPUT:`${root}/browser`,SPECIAL_BUTTON_COVERAGE_DIR:`${root}/browser-coverage`,PLAYWRIGHT_BROWSERS_PATH:'/browsers'};
if(env.MBT_TEST_ISOLATED!=='1'||!env.DATABASE_URL?.endsWith('/mbt_verify'))throw new Error('Use the isolated verification database');
mkdirSync(root,{recursive:true});
function run(name,args,extra={}) {
  const result=spawnSync(process.execPath,args,{encoding:'utf8',env:{...env,...extra},timeout:600000,maxBuffer:20*1024*1024});
  writeFileSync(`${root}/${name}.txt`,result.stdout+result.stderr);
  if(result.status!==0)throw new Error(`${name} failed; see ${root}/${name}.txt`);
  console.log(`PASS ${name}`);
}
if(process.argv.includes('--finish') || process.argv.includes('--refresh-browser')) {
  const verified=JSON.parse(readFileSync(`${root}/final/source-manifest.json`));
  const browserFile='tools/special-workflow-enquiry-browser.mjs';
  for(const [file,sha]of Object.entries(verified)) {
    if(process.argv.includes('--refresh-browser') && file===browserFile)continue;
    if(createHash('sha256').update(readFileSync(file)).digest('hex')!==sha)throw new Error('Verified source changed: '+file);
  }
  if(process.argv.includes('--refresh-browser')) {
    run('refreshed-browser',[browserFile]);
    verified[browserFile]=createHash('sha256').update(readFileSync(browserFile)).digest('hex');
    writeFileSync(`${root}/final/source-manifest.json`,JSON.stringify(verified,null,2));
  }
} else run('regressions',['tools/special-workflow-enquiry-gauntlet.mjs']);
const faults=[
  ['disabled styling missing','public/stock-requests.css','.special-stock-page button:disabled','.unused-special-state button:disabled','pending-review-visible-lock'],
  ['pending review ignored','public/sales-special-stock-requests.js',': state.detail?.quantityReviewPending ?',': false ?','pending-review-visible-lock'],
  ['media clears dirty state','public/sales-special-stock-requests.js','state.soDraft.media = state.detail.media.filter','state.soDraftDirty = false;\n    state.soDraft.media = state.detail.media.filter','media-retains-quantity-lock'],
  ['five columns lost','public/stock-requests.css','grid-template-columns: repeat(5, minmax(0, 1fr));','grid-template-columns: repeat(3, minmax(0, 1fr));','so-material-five-column-row']
];
const mutants=[];
for(const [name,file,from,to,filter]of faults) {
  const result=spawnSync(process.execPath,['tools/special-workflow-enquiry-browser.mjs'],{encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024,env:{...env,SPECIAL_BUTTON_COVERAGE_DIR:'',SPECIAL_POLISH_BROWSER_MUTATION:JSON.stringify([file,from,to]),SPECIAL_POLISH_BROWSER_FILTER:filter,SPECIAL_POLISH_BROWSER_OUTPUT:`${root}/mutants/${mutants.length}`}});
  writeFileSync(`${root}/mutant-${mutants.length}.txt`,result.stdout+result.stderr);
  if(result.status!==1||!result.stdout.includes(`FAIL ${filter}:`)||/SyntaxError|ERR_MODULE_NOT_FOUND/.test(result.stdout+result.stderr))throw new Error('Invalid/surviving mutant '+name);
  mutants.push({name,killed:true,propertyOnly:'not applicable: DOM/CSS behavior'});
  console.log('KILLED '+name);
}
writeFileSync(`${root}/mutations.json`,JSON.stringify(mutants,null,2));
const file='public/sales-special-stock-requests.js',source=readFileSync(file,'utf8');
const map=coverage.createCoverageMap({});
for(const entry of readdirSync(env.SPECIAL_BUTTON_COVERAGE_DIR).flatMap(name=>JSON.parse(readFileSync(`${env.SPECIAL_BUTTON_COVERAGE_DIR}/${name}`)))) {
  if(entry.source!==source)throw new Error('Browser coverage source drift');
  const converter=v8ToIstanbul(file,0,{source});await converter.load();converter.applyCoverage(entry.functions);map.merge(converter.toIstanbul());
}
const measured=map.fileCoverageFor(map.files().find(name=>name.endsWith(file)));
const changed=JSON.parse(readFileSync('test/special-workflow-so-buttons-changed-lines.json'));
if(changed.sha256!==createHash('sha256').update(source).digest('hex'))throw new Error('Changed-line source drift');
const lines=measured.getLineCoverage(),uncovered=changed.lines.filter(line=>!lines[line]);
const report={file,covered:changed.lines.length-uncovered.length,total:changed.lines.length,uncovered,branchCoverage:measured.toSummary().branches};
writeFileSync(`${root}/changed-line-coverage.json`,JSON.stringify(report,null,2));
if(uncovered.length)throw new Error('Uncovered changed browser lines: '+uncovered);
console.log(`PASS changed browser lines ${report.covered}/${report.total}`);
const manifest=JSON.parse(readFileSync(`${root}/final/source-manifest.json`));
for(const added of ['test/special-workflow-so-buttons-spec.md','test/special-workflow-so-buttons-changed-lines.json','tools/special-workflow-so-buttons-check.mjs'])manifest[added]=createHash('sha256').update(readFileSync(added)).digest('hex');
writeFileSync(`${root}/final/source-manifest.json`,JSON.stringify(manifest,null,2));
console.log('SO button and row gauntlet passed; no live order writes.');

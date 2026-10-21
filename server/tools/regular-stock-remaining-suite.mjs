import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=['unit','integration','property'].flatMap(kind=>readdirSync(`test/mbt/${kind}`).filter(file=>/^regular-stock.*\.test\.js$/.test(file)).map(file=>`test/mbt/${kind}/${file}`))
  .filter(file=>process.argv[2]!=='baseline'||!file.includes('regular-stock-remaining.'));
if(process.argv[2]==='reverse') {
  let tests=0,passed=0,failed=0,exitCode=0;
  // Node sorts a multi-file invocation; separate invocations enforce this order.
  for(const file of files.sort().reverse()) {
    const result=spawnSync(process.execPath,['--test','--test-concurrency=1',file],{encoding:'utf8',maxBuffer:20_000_000});
    const output=(result.stdout||'')+(result.stderr||'');
    tests+=Number(output.match(/^# tests (\d+)/m)?.[1]||0);
    passed+=Number(output.match(/^# pass (\d+)/m)?.[1]||0);
    failed+=Number(output.match(/^# fail (\d+)/m)?.[1]||0);
    if(result.status!==0)exitCode=1;
    console.log('# file '+file+'\n'+output.replace(/^# (tests|pass|fail) \d+\n/gm,''));
  }
  console.log(`# tests ${tests}\n# pass ${passed}\n# fail ${failed}`);
  process.exit(exitCode);
}
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{stdio:'inherit'});
process.exit(result.status??1);

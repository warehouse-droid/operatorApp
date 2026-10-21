import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const out='test-artifacts/mbr-signing-defaults/mutations';await mkdir(out,{recursive:true});
const mutants=[
  {name:'signing-moves-back-to-third',before:"${completed?signedHtml(contract):signingForm()}<section",after:"${completed?signedHtml(contract):''}<section",secondBefore:'${agreementHtml(contract.paragraphs)}</section>`;',secondAfter:"${agreementHtml(contract.paragraphs)}</section>${completed?'':signingForm()}`;"},
  {name:'accept-default-removed',before:'value="accept" required checked',after:'value="accept" required'},
  {name:'consent-default-removed',before:'name="consent" required checked',after:'name="consent" required'},
  {name:'blank-signature-client-guard-removed',before:'if(!pad.hasInk())',after:'if(false && !pad.hasInk())',full:true}
];
const results=[];
for(const mutant of mutants) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'mbr-signing-defaults-mutant-'));
  try {
    for(const folder of ['src','public','migrations','test/mbr']) {await cp(folder,path.join(directory,folder),{recursive:true,dereference:true});}
    await mkdir(path.join(directory,'test/field-sales'),{recursive:true});
    await cp('test/field-sales/pdf-text.js',path.join(directory,'test/field-sales/pdf-text.js'));
    await cp('package.json',path.join(directory,'package.json'));
    await symlink(path.resolve('node_modules'),path.join(directory,'node_modules'));
    await symlink(path.resolve('test-artifacts'),path.join(directory,'test-artifacts'));
    const file=path.join(directory,'public/mbr/customer.js'),original=await readFile(file,'utf8');
    assert.equal(original.split(mutant.before).length,2,'Unique mutation source: '+mutant.name);
    let modified=original.replace(mutant.before,mutant.after);
    if(mutant.secondBefore) {
      assert.equal(modified.split(mutant.secondBefore).length,2);modified=modified.replace(mutant.secondBefore,mutant.secondAfter);
    }
    await writeFile(file,modified);
    const result=spawnSync(process.execPath,['test/mbr/signing-defaults-browser.mjs'],{cwd:directory,encoding:'utf8',timeout:90000,killSignal:'SIGKILL',maxBuffer:8*1024*1024,
      env:{...process.env,MBR_SIGNING_INITIAL_ONLY:mutant.full?'0':'1',MBR_SIGNING_BROWSER_OUT:out+'/'+mutant.name}});
    const output=(result.stdout || '')+(result.stderr || '');await writeFile(`${out}/${mutant.name}.log`,output);
    assert.doesNotMatch(output,/ERR_MODULE_NOT_FOUND|SyntaxError|ENOSPC|ERR_NAME_NOT_RESOLVED/u);
    assert.match(output,/FAIL|AssertionError/u,'Mutation must fail on an assertion');
    const killed=result.status!==0 && !result.error && !result.signal;
    results.push({name:mutant.name,killed});console.log(JSON.stringify(results.at(-1)));
    assert.equal(killed,true,'Mutation survived: '+mutant.name);
  } finally {await rm(directory,{recursive:true,force:true});}
}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));

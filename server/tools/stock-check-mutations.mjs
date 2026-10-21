import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=process.cwd(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'stock-check-mutants-'));
const definitions=[
  {name:'accept zero pallets',file:'domain.js',from:"if((!isNumeric && !isWholeText) || number<1 || number>99999)",to:"if((!isNumeric && !isWholeText) || number<0 || number>99999)"},
  {name:'ignore partial cart acceptance',file:'domain.js',from:'actual!==expected',to:'false'},
  {name:'replace every product plant with Ayr',file:'domain.js',from:'return {...found};',to:"return {code:'07',name:'Ayr'};"},
  {name:'leak stored credential payload',file:'domain.js',from:'return {id:row.id,vendorId:',to:'return {encrypted_secret:row.encrypted_secret,id:row.id,vendorId:'},
  {name:'drop vendor binding from credential encryption',file:'vault.js',from:"+vendorId+':'+accountId",to:"+0+':'+accountId"},
  {name:'treat scheduled production as immediate stock',file:'domain.js',from:"status='in_production';eta=",to:"status='in_stock';eta="},
  {name:'assume unfamiliar availability means in stock',file:'domain.js',from:"let status='unknown',eta=null;",to:"let status='in_stock',eta=null;"},
  {name:'ignore the cart availability when confirming accepted quantities',file:'domain.js',from:"if(availability.status==='in_stock')",to:'if(true)'}
];
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const original={};for(const name of ['domain.js','vault.js']) {original[name]=await fs.readFile('src/stock-check/'+name,'utf8');}
const report=[];
try {
  await fs.mkdir(path.join(temp,'src/stock-check'),{recursive:true});await fs.writeFile(path.join(temp,'package.json'),'{"type":"module"}');
  await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'));
  const tests=['test/mbt/unit/stock-check-domain.test.js','test/mbt/unit/stock-check-vault.test.js','test/mbt/property/stock-check.property.test.js'];
  for(const file of tests) {await fs.mkdir(path.dirname(path.join(temp,file)),{recursive:true});await fs.copyFile(file,path.join(temp,file));}
  for(const mutant of definitions) {
    for(const [file,source] of Object.entries(original)) {await fs.writeFile(path.join(temp,'src/stock-check',file),source);}
    const source=original[mutant.file];if(!source.includes(mutant.from)) {throw new Error('Mutation target moved: '+mutant.name);}
    await fs.writeFile(path.join(temp,'src/stock-check',mutant.file),source.replace(mutant.from,mutant.to));
    const runs=[];
    for(const suite of ['unit','property']) {
      const files=suite==='unit'?tests.slice(0,2):tests.slice(2);
      const result=spawnSync(process.execPath,['--test',...files],{cwd:temp,encoding:'utf8',timeout:60000});
      const failed=/not ok \d/u.test(result.stdout)&&!/(SyntaxError|ERR_MODULE_NOT_FOUND)/u.test(result.stderr);
      runs.push({suite,killed:result.status!==0&&failed});
      await fs.writeFile('test-artifacts/stock-check/mutant-'+report.length+'-'+suite+'.log',result.stdout+result.stderr);
    }
    report.push({name:mutant.name,runs});
  }
  for(const [file,source] of Object.entries(original)) {if(hash(await fs.readFile('src/stock-check/'+file))!==hash(source)) {throw new Error('Source changed during mutation testing.');}}
  await fs.writeFile('test-artifacts/stock-check/mutations.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({mutants:report.length,unitKilled:report.filter(row=>row.runs[0].killed).length,propertyKilled:report.filter(row=>row.runs[1].killed).length,sourceUnchanged:true}));
  if(report.some(row=>row.runs.some(run=>!run.killed))) {process.exitCode=1;}
} finally {await fs.rm(temp,{recursive:true,force:true});}

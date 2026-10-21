import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const directory='test-artifacts/stocking-replies-20261006';
const files=JSON.parse(await readFile('tools/stocking-replies-files.json','utf8'));
const hashes=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(file)).digest('hex')])));
const sourceHashes=await hashes();
for(const script of ['tools/stocking-replies-gauntlet.mjs','tools/stocking-replies-smart-width.mjs']){
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[script],{stdio:'inherit'});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new Error(`${script} exited ${code}`)));
  });
}
assert.deepEqual(await hashes(),sourceHashes,'All release files remain unchanged during verification');
const gauntlet=JSON.parse(await readFile(`${directory}/gauntlet.json`,'utf8'));
const layout=JSON.parse(await readFile(`${directory}/smart-width.json`,'utf8'));
assert.ok(gauntlet.passed&&layout.passed);
for(const layer of [gauntlet,layout])for(const [file,hash] of Object.entries(layer.sourceHashes))assert.equal(sourceHashes[file],hash);
await writeFile(`${directory}/final-validation.json`,JSON.stringify({passed:true,at:new Date().toISOString(),sourceHashes,gauntletAt:gauntlet.at,layoutAt:layout.at},null,2));
console.log(JSON.stringify({passed:true,validatedReleaseFiles:files.length}));

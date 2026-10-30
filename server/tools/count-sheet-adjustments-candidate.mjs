import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const manifest = JSON.parse(readFileSync('/release/manifest.json'));
const hashes = {};
const hash = path => {hashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');};
function walk(directory) {
  if (!existsSync(directory)) {return;}
  for (const entry of readdirSync(directory, {withFileTypes:true})) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) {walk(path);} else if (entry.isFile()) {hash(path);}
  }
}
for (const directory of ['src','public','migrations','contracts']) {walk(directory);}
for (const file of ['package.json','package-lock.json']) {hash(file);}
assert.deepEqual(hashes, manifest.candidateTree, 'The tested image must equal the complete captured runtime');
const check = spawnSync(process.execPath, ['tools/count-sheet-adjustments-checks.mjs'], {stdio:'inherit'});
assert.equal(check.status, 0, 'Candidate validation failed');
const evidence = JSON.parse(readFileSync('test-artifacts/count-adjustments/evidence.json'));
assert.ok(evidence.passed);
assert.equal(evidence.tests.tests, manifest.expectedTests ?? 108);
assert.equal(evidence.tests.fail, 0);
for (const name of manifest.files) {assert.equal(evidence.hashes[name], hashes[name], name);}
const result = {passed:true, at:new Date().toISOString(), imageId:manifest.candidateImageId,
  candidateTreeHash:manifest.candidateTreeHash, tests:evidence.tests, mutations:evidence.mutants,
  changedCoverage:evidence.changedCoverage, versions:evidence.versions, runtimeFilesVerified:Object.keys(hashes).length};
writeFileSync('/release/validation-passed.json', JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result));

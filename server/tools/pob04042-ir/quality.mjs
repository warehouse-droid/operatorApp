import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const files = ['proof.mjs', 'recover.mjs'];
const roots = files.map(name => `/app/tools/pob04042-ir/${name}`);
const types = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit',
  '--skipLibCheck', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', ...roots],
{ encoding: 'utf8', cwd: '/app', maxBuffer: 20000000 });
const diagnostics = types.stdout.split('\n').filter(line => /error TS\d+/.test(line));
assert.ok([0, 1, 2].includes(types.status) && !types.error, types.stderr);
assert.ok(types.status === 0 || diagnostics.length > 0, 'Compiler failed without type diagnostics');
const scoped = diagnostics.filter(line => line.includes('tools/pob04042-ir/'));
console.log(JSON.stringify({ typeErrorsInRecoveryFiles: scoped.length, inheritedDiagnostics: diagnostics.length - scoped.length }));
for (const diagnostic of scoped) { console.log(diagnostic); }
assert.equal(scoped.length, 0);
const lint = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '--config', '/app/eslint.mbt.config.js', '--max-warnings=0', ...roots], { encoding: 'utf8', cwd: '/app' });
console.log(lint.stdout, lint.stderr);
assert.equal(lint.status, 0);
const original = readFileSync(roots[0], 'utf8');
const mutations = [
  ['command identity', "assert.equal(command.id, commandId);", ''],
  ['freight type', "assert.equal(actual.itemType, 'OthCharge');", ''],
  ['freight amount', 'assert.equal(actual.itemFxAmount, 130.42);', ''],
  ['inventory identity', 'return { ...snapshot, itemId };', 'return { ...snapshot };'],
  ['receipt identity', 'return { ...verified, freight };', 'return { ...verified, id: 1071916, freight };']
];
const temporary = '/tmp/pob04042-mutations';
mkdirSync(`${temporary}/tools`, { recursive: true });
symlinkSync('/app/src', `${temporary}/src`);
symlinkSync('/app/node_modules', `${temporary}/node_modules`);
cpSync('/app/tools/pob04042-ir', `${temporary}/tools/pob04042-ir`, { recursive: true });
try {
  for (const [name, before, after] of mutations) {
    assert.equal(original.split(before).length, 2);
    writeFileSync(`${temporary}/tools/pob04042-ir/proof.mjs`, original.replace(before, after));
    for (const suite of ['proof.test.mjs', 'property.test.mjs']) {
      const result = spawnSync(process.execPath, ['--test', `${temporary}/tools/pob04042-ir/${suite}`], { encoding: 'utf8' });
      assert.equal(result.status, 1, `${name} survived ${suite}`);
      assert.match(result.stdout, /not ok/);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|SyntaxError/);
      console.log(JSON.stringify({ mutant: name, suite, killed: true }));
    }
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
const sha = createHash('sha256');
for (const file of readdirSync('/app/tools/pob04042-ir').sort()) {
  sha.update(file); sha.update(readFileSync(`/app/tools/pob04042-ir/${file}`));
}
console.log(JSON.stringify({ sourceHash: sha.digest('hex'), node: process.version,
  versions: Object.fromEntries(['typescript', 'eslint', 'fast-check'].map(name =>
    [name, JSON.parse(readFileSync(`/app/node_modules/${name}/package.json`, 'utf8')).version])) }));

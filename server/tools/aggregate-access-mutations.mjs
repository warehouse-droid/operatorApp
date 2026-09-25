import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { mutants } from '../test/support/aggregate-access-mutation-loader.mjs';
const root = 'test-artifacts/aggregate-access-mutations';
await mkdir(root, { recursive: true });
const results = [];
for (const [name, , group] of mutants) {
  for (const propertyOnly of group === 'unit' ? [false, true] : [false]) {
    const args = ['--loader', './test/support/aggregate-access-mutation-loader.mjs', '--test'];
    if (propertyOnly) { args.push('--test-name-pattern=property:'); }
    args.push(`test/mbt/${group}/aggregate-request-access.test.js`);
    const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000,
      env: { ...process.env, AGGREGATE_ACCESS_MUTATION: name } });
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    const killed = run.status === 1 && output.includes(`AGGREGATE_ACCESS_MUTATION_APPLIED:${name}`)
      && /# fail [1-9]/.test(output) && !output.includes('Mutation anchor must occur');
    results.push({ name, propertyOnly, killed });
    await writeFile(`${root}/${name}${propertyOnly ? '-properties' : ''}.log`, output);
    console.log(`${name}${propertyOnly ? ' (properties)' : ''}: ${killed ? 'killed' : 'SURVIVED / INVALID'}`);
  }
}
await writeFile(`${root}/results.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.killed)) { process.exitCode = 1; }

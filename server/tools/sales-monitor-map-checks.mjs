import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mutants, allowedLine } from '../test/support/sales-monitor-map-mutation-loader.mjs';

const feature = 'test/mbt/integration/sales-monitor-map.test.js';
const neighbors = ['test/dispatch/integration/dispatch-v2-sales-read-access.red.test.js',
  'test/dispatch/frontend/google-maps-usage-control.contract.test.js',
  'test/mbt/unit/google-maps-usage-policy.red.test.js', 'test/mbt/property/google-maps-usage-policy.property.test.js'];
const run = (args, options = {}) => spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, ...options });
const checked = args => {
  const result = run(args, { stdio: 'inherit' });
  assert.equal(result.status, 0, args.join(' '));
};
const root = 'test-artifacts/sales-monitor-map-checks';
await mkdir(root, { recursive: true });

if (process.argv[2] === 'static') {
  const source = await readFile('src/server.js', 'utf8');
  const guard = source.match(/^function requireDispatchAccess\(req, res, next\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(guard);
  await writeFile('test-artifacts/sales-monitor-guard.js', guard.replace('function requireDispatchAccess', 'export function requireDispatchAccess') + '\n');
  await writeFile('test-artifacts/sales-monitor-guard.ts', `
    interface Actor { role?: string; roles?: string[] }
    interface Request { method: string; path: string; operator: Actor }
    interface Response { status(code: number): Response; json(body: unknown): void }
    declare function operatorHasAnyRole(actor: Actor, roles: string[]): boolean;
    declare function sendRoleForbidden(res: Response, actor: Actor, message: string): void;
    ${guard.replace('(req, res, next)', '(req: Request, res: Response, next: () => void)')}
    export {};
  `);
  for (const file of ['src/server.js', feature, 'tools/sales-monitor-map-checks.mjs', 'tools/sales-monitor-map-live.mjs', 'test/support/sales-monitor-map-mutation-loader.mjs']) { checked(['--check', file]); }
  checked(['node_modules/eslint/bin/eslint.js', '--config', 'tools/sales-monitor-map-eslint.config.mjs', '--max-warnings=0', feature,
    'test/support/sales-monitor-map-mutation-loader.mjs', 'tools/sales-monitor-map-checks.mjs', 'tools/sales-monitor-map-live.mjs', 'test-artifacts/sales-monitor-guard.js']);
  checked(['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', 'test-artifacts/sales-monitor-guard.ts']);
  console.log('Syntax, lint and strict authorization function types passed.');
} else if (process.argv[2] === 'coverage') {
  const coverage = JSON.parse(await readFile('test-artifacts/sales-monitor-map-coverage/coverage-final.json', 'utf8'));
  const file = Object.keys(coverage).find(name => name.endsWith('/src/server.js'));
  assert.ok(file);
  const source = await readFile('src/server.js', 'utf8');
  const line = source.split('\n').findIndex(value => value === allowedLine) + 1;
  assert.ok(line > 0);
  const row = coverage[file];
  const statements = Object.entries(row.statementMap).filter(([, value]) => value.start.line <= line && value.end.line >= line);
  assert.ok(statements.length && statements.every(([id]) => row.s[id] > 0));
  const branches = Object.entries(row.branchMap).filter(([, value]) => value.loc.start.line === line).map(([id]) => row.b[id]);
  assert.ok(branches.length && branches.flat().every(count => count > 0));
  const result = { changedLines: 1, covered: 1, branches: branches.flat().length, coveredBranches: branches.flat().filter(count => count > 0).length };
  await writeFile(`${root}/coverage.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} else if (process.argv[2] === 'mutations') {
  const results = [];
  for (const [name] of mutants) {
    for (const propertiesOnly of [false, true]) {
      const args = ['--loader', './test/support/sales-monitor-map-mutation-loader.mjs', '--test'];
      if (propertiesOnly) { args.push('--test-name-pattern=property: the Sales exception'); }
      args.push(feature);
      const result = run(args, { env: { ...process.env, SALES_MONITOR_MUTATION: name } });
      const output = result.stdout + result.stderr;
      await writeFile(`${root}/mutant-${name}-${propertiesOnly ? 'property' : 'all'}.log`, output);
      const killed = result.status !== 0 && /not ok \d+ - /.test(output) && output.includes(`SALES_MONITOR_MUTATION_APPLIED:${name}`);
      assert.ok(killed, `Surviving mutant ${name}, property=${propertiesOnly}`);
      results.push({ name, propertiesOnly, killed });
    }
  }
  await writeFile(`${root}/mutations.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} else if (process.argv[2] === 'shuffle') {
  const hash = value => createHash('sha256').update('20260922:' + value).digest('hex');
  for (const file of [feature, ...neighbors].sort((a, b) => hash(a).localeCompare(hash(b)))) {
    console.log('Suite health seed 20260922: ' + file);
    if (file.endsWith('google-maps-usage-control.contract.test.js')) {
      const baseline = JSON.parse(await readFile('test/sales-monitor-map-neighbor-baseline.json', 'utf8'));
      const result = run(['--test', file]);
      const output = result.stdout + result.stderr;
      console.log(output);
      assert.equal(result.status, 1);
      assert.deepEqual([...output.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]), baseline.knownFailures);
      console.log('Only the recorded pre-existing Maps contract failure remains.');
    } else { checked(['--test', file]); }
  }
} else { throw new Error('Choose static, coverage, mutations or shuffle'); }

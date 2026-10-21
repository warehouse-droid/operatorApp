import { readdir, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runNodeTestFilesIsolated } from '../test/support/test-database-isolation.mjs';

const mode = process.argv[2], artifact = 'test-artifacts/operator-to-yard-flow';
await mkdir(artifact, { recursive: true });
async function filesIn(directory) {
  const found = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { found.push(...await filesIn(name)); }
    else if (/\.test\.(?:js|mjs)$/u.test(name)) { found.push(name); }
  }
  return found;
}
if (mode === 'full-baseline' || mode === 'full-final') {
  const files = (await filesIn('test/mbt')).filter(file => !file.includes('/e2e/')
    && (mode !== 'full-baseline' || !file.includes('operator-to-yard-flow')));
  process.exitCode = await runNodeTestFilesIsolated(files, { environment: process.env, label: mode });
} else if (mode === 'static') {
  for (const file of ['src/transfer-order-posting-domain.js', 'src/transfer-order-posting-repository.js', 'src/transfer-order-posting-service.js',
    'src/delivery-repository.js', 'src/receiving-repository.js', 'src/order-sync-repository.js', 'src/server.js']) {
    const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (r.status) { process.exit(r.status); }
  }
  const types = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.mbt.json', '--noEmit'], { encoding: 'utf8' });
  await writeFile(`${artifact}/types-${process.env.TO_YARD_TYPE_LABEL || 'final'}.log`, types.stdout + types.stderr);
  console.log(`Types exit: ${types.status}`);
  const files = ['src/transfer-order-posting-domain.js', 'src/transfer-order-posting-repository.js', 'src/transfer-order-posting-service.js',
    'test/mbt/integration/operator-to-yard-flow.test.js', 'test/support/operator-to-yard-flow-fixture.mjs', 'tools/operator-to-yard-flow-checks.mjs'];
  const lint = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '--config', 'tools/operator-to-yard-flow-eslint.config.mjs', '--max-warnings=0', ...files,
    'test/mbt/property/operator-to-yard-flow.property.test.js', 'tools/operator-to-yard-flow-mutations.mjs'], { stdio: 'inherit' });
  process.exitCode = lint.status || 0;
} else if (mode === 'source') {
  const names = ['src/transfer-order-posting-domain.js', 'src/transfer-order-posting-repository.js', 'src/transfer-order-posting-service.js',
    'src/delivery-repository.js', 'src/receiving-repository.js', 'src/order-sync-repository.js', 'src/server.js', 'src/netsuite.js', 'migrations/279_operator_to_yard_flow.sql'];
  const hashes = Object.fromEntries(await Promise.all(names.map(async name => [name, createHash('sha256').update(await readFile(name)).digest('hex')])));
  await writeFile(`${artifact}/source-hashes.json`, JSON.stringify(hashes, null, 2) + '\n');
  console.log(JSON.stringify({ node: process.version, files: hashes }));
} else { throw new Error(`Unknown check mode ${mode}`); }

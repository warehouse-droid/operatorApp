import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const directory = await mkdtemp('/tmp/if-static-lines-mutants-');
const artifact = 'test-artifacts/operator-if-static-lines/mutations';
const helper = 'src/operator-netsuite-posting-fulfillment-lines.js';
const mutations = [
  ['keep-completed-false', helper, 'Number(line.remainingQuantity) > 0', 'Number(line.remainingQuantity) >= 0'],
  ['lose-open-false', helper, 'return openFulfillableLine(line);', 'return false;'],
  ['clamp-selected-quantity', helper, 'assertSelectedLine(step, item, line);', 'assertSelectedLine(step, item, line);\n    item.quantity = Math.min(item.quantity, line.remainingQuantity);'],
  ['ignore-stable-identity', helper, 'snapshot.sourceLineKey && String(snapshot.sourceLineKey)', 'false && String(snapshot.sourceLineKey)'],
  ['ignore-selected-location', helper, 'Number(item.location) !== Number(line.location)', 'false'],
  ['omit-open-kit-parent', 'src/netsuite.js', 'Boolean(row.order_line) && (includeAllSourceLines', 'Boolean(row.order_line) && (false'],
  ['receive-new-unselected-line', helper, 'items.push({ orderLine, itemReceive: false,', 'items.push({ orderLine, itemReceive: true,']
];
const testFile = 'test/mbt/unit/operator-if-static-lines.test.js';
await mkdir(artifact, { recursive: true });
try {
  for (const name of ['src', 'public', 'contracts', 'package.json', testFile, 'test/support/operator-kit-fixture.mjs']) {
    await cp(name, `${directory}/${name}`, { recursive: true });
  }
  await symlink('/app/node_modules', `${directory}/node_modules`);
  const originals = Object.fromEntries(await Promise.all([...new Set(mutations.map(row => row[1]))]
    .map(async name => [name, await readFile(`${directory}/${name}`, 'utf8')])));
  const results = [];
  for (const propertyOnly of [false, true]) {
    for (const [name, path, before, after] of mutations) {
      const original = originals[path];
      assert.equal(original.split(before).length, 2, `Unique mutation anchor: ${name}`);
      await writeFile(`${directory}/${path}`, original.replace(before, after));
      const args = ['--test', '--test-concurrency=1', ...(propertyOnly ? ['--test-name-pattern=property'] : []), testFile];
      const run = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 45000 });
      const log = (run.stdout || '') + (run.stderr || '');
      await writeFile(`${artifact}/${propertyOnly ? 'property-' : ''}${name}.log`, log);
      await writeFile(`${directory}/${path}`, original);
      assert.ok(run.status !== 0 && /not ok/u.test(log) && !/SyntaxError|ERR_MODULE_NOT_FOUND/u.test(log),
        `Mutation survived or infrastructure failed: ${name}`);
      results.push({ name, propertyOnly, killed: true });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
  await writeFile(`${artifact}/results.json`, JSON.stringify(results, null, 2) + '\n');
} finally { await rm(directory, { recursive: true, force: true }); }

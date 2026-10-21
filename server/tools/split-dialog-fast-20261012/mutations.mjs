import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function runMutations({ snapshot, tests, reset, out, primary }) {
  const repo = 'src/dispatch-split-preview-repository.js';
  const mutants = [
    { name: 'dialog waits for the remote check again', file: 'public/dispatch.js', transform: source => {
      const start = source.indexOf('  if (action === "open-split-modal") {');
      return source.slice(0, start) + source.slice(start).replace('    renderDispatchModalInPlace();', '    if (!splitStatusLoading) renderDispatchModalInPlace();');
    } },
    { name: 'pending confirmation is enabled', file: 'public/dispatch.js',
      from: 'data-order="${escapeHtml(order.id)}" disabled type="button">Create Split Orders',
      to: 'data-order="${escapeHtml(order.id)}" type="button">Create Split Orders' },
    { name: 'receiving progress is mistaken for outbound progress', file: repo,
      from: `\${kind === "TO" ? "AND line_stage='outbound'" : ""}`, to: '' },
    { name: 'registered split takes whole parent quantity', file: repo,
      from: 'definition?.items || lines.filter', to: 'lines.filter' }
  ];
  const results = [];
  for (const [index, mutant] of mutants.entries()) {
    const root = snapshot();
    try {
      const file = root + '/' + mutant.file, original = readFileSync(file, 'utf8');
      const changed = mutant.transform ? mutant.transform(original) : original.replace(mutant.from, mutant.to);
      assert.notEqual(changed, original, mutant.name + ' did not change the code');
      writeFileSync(file, changed);
      assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0, mutant.name + ' introduced syntax errors');
      reset();
      const result = tests('mutant-' + index, primary, { cwd: root });
      assert.ok(result.fail > 0 && result.exit !== 0, mutant.name + ' survived');
      assert.ok(!/SyntaxError:|ERR_MODULE_NOT_FOUND/u.test(result.log), mutant.name + ' failed on infrastructure');
      let property = null;
      if (mutant.property) {
        reset();
        const isolated = tests('mutant-property-' + index, primary, { cwd: root, pattern: 'property:' });
        property = { killed: isolated.fail > 0 && isolated.exit !== 0, failures: isolated.failures };
        assert.equal(property.killed, true, mutant.name + ' survived its property suite');
      }
      results.push({ name: mutant.name, file: mutant.file, killed: true, failures: result.failures, property });
      writeFileSync(out + '/mutations.json', JSON.stringify(results, null, 2) + '\n');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}

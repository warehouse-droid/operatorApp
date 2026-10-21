import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const definitions = [
  { name: 'idle-boundary-off-by-one', file: 'public/dispatch-edit-activity.js', from: 'ageMs() < idleLimitMs', to: 'ageMs() <= idleLimitMs', suite: 'frontend/dispatch-editor-idle.test.js' },
  { name: 'synthetic-input-renews', file: 'public/dispatch-edit-activity.js', from: '!event.isTrusted', to: 'false', suite: 'frontend/dispatch-editor-idle.test.js' },
  { name: 'layout-scroll-renews', file: 'public/dispatch-edit-activity.js', from: "'touchmove', 'wheel'", to: "'touchmove', 'wheel', 'scroll'", suite: 'frontend/dispatch-editor-idle.test.js' },
  { name: 'confirmation-bypassed', file: 'public/dispatch.js', from: 'if (!window.confirm(`Kick ${selected.operatorName', to: 'if (false && !window.confirm(`Kick ${selected.operatorName', suite: 'frontend/dispatch-editor-actions.test.js' },
  { name: 'old-page-heartbeat-renews', file: 'src/dispatch-plan-lease-repository.js', from: 'THEN expires_at\n', to: "THEN clock_timestamp() + interval '10 minutes'\n", suite: 'integration/dispatch-editor-control.test.js' },
  { name: 'stale-selection-kicks-new-session', file: 'src/dispatch-plan-lease-repository.js', from: ' || current.selectionId !== input.selectionId', to: '', suite: 'integration/dispatch-editor-control.test.js' }
];
const results = [], root = '/tmp/editor-control-mutants';
try {
  await mkdir(root, { recursive: true });
  for (const mutant of definitions) {
    const directory = root + '/' + mutant.name;
    await mkdir(directory);
    for (const name of ['src', 'public', 'test']) {await cp(name, directory + '/' + name, { recursive: true });}
    for (const name of ['node_modules', 'package.json', 'migrations', 'contracts']) {await symlink('/app/' + name, directory + '/' + name);}
    const path = directory + '/' + mutant.file, original = await readFile(path, 'utf8');
    assert.ok(original.includes(mutant.from), 'Mutation target missing: ' + mutant.name);
    await writeFile(path, original.replace(mutant.from, mutant.to));
    const tested = spawnSync(process.execPath, ['tools/bin-planning-suites.mjs', 'selected', directory + '/test/dispatch/' + mutant.suite],
      { env: { ...process.env, NODE_V8_COVERAGE: '' }, encoding: 'utf8', timeout: 90000 });
    const output = tested.stdout + tested.stderr;
    await writeFile('test-artifacts/mutant-' + mutant.name + '.log', output);
    const killed = tested.status !== 0 && /AssertionError|assert|Property failed/.test(output) && !/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output);
    results.push({ name: mutant.name, exit: tested.status, killed });
    console.log(JSON.stringify(results.at(-1)));
    await rm(directory, { recursive: true, force: true });
  }
} finally {await rm(root, { recursive: true, force: true });}
await writeFile('test-artifacts/mutations.json', JSON.stringify(results, null, 2));
assert.ok(results.every(result => result.killed), 'A deliberately broken implementation survived');

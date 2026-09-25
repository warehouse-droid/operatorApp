import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2] || 'candidate';
const files = ['src/dispatch-plan-fence.js', 'src/dispatch-plan-write.js', 'src/dispatch-plan-lease-repository.js',
  'src/dispatch-plan-repository.js', 'src/dispatch-planner-performance.js', 'src/dispatch-planner-v2-repository.js',
  'src/server.js', 'src/scm-dependency-preview-service.js', 'src/scm-dependency-command-service.js', 'src/scm-dependency-plan-reconciler.js', 'src/dispatch-delivery-group-repository.js',
  'public/dispatch.js', 'public/dispatch-save-journal.js', 'public/dispatch-snapshot.js'];
const present = [];
for (const file of files) if (await readFile(file).then(() => true).catch(() => false)) present.push(file);
const lint = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', '--config', 'tools/dispatch-save-eslint.config.mjs', '--format=json', ...present], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
assert.ok([0, 1].includes(lint.status), lint.stderr);
const types = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.mbt.json', '--noEmit'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const report = { mode, lint: JSON.parse(lint.stdout), typesExit: types.status, types: types.stdout + types.stderr };
await writeFile(`test-artifacts/dispatch-save-reliability/static-${mode}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ mode, lintErrors: report.lint.reduce((n, f) => n + f.errorCount, 0), typeExit: report.typesExit }));

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { production, tests } from './operator-kit-files.mjs';
const output = 'test-artifacts/operator-kit/final';
const result = spawnSync('node_modules/.bin/c8', ['--all=false', '--check-coverage=false',
  ...production.map(file => `--include=${file}`), `--temp-directory=${output}/c8`, `--report-dir=${output}/coverage`,
  '--reporter=text', '--reporter=json', '--reporter=json-summary',
  process.execPath, '--test', '--test-concurrency=1', ...tests], { stdio: 'inherit' });
assert.equal(result.status, 0);

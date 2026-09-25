import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ESLint } from 'eslint';
import base from '../eslint.mbt.config.js';
const result = spawnSync('node_modules/.bin/tsc', ['--project', 'tsconfig.mbt.json', '--pretty', 'false'], { encoding: 'utf8', maxBuffer: 50e6 });
const types = (result.stdout + result.stderr).split('\n').filter(line => /error TS\d+/u.test(line)).map(line => line.replace(/\(\d+,\d+\)/u, '')).sort();
const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: base });
const lint = (await eslint.lintFiles(['src/sales-order-auto-fulfillment-repository.js'])).flatMap(file => file.messages.map(message =>
  `${file.filePath.replace('/app/', '')}:${message.ruleId}:${message.message}`)).sort();
writeFileSync('test-artifacts/co-completion/static-baseline.json', JSON.stringify({ types, lint }, null, 2));
writeFileSync('test-artifacts/co-completion/types-baseline.log', result.stdout + result.stderr);
const hashes = Object.fromEntries(['package.json', 'package-lock.json'].map(file => [file,
  createHash('sha256').update(readFileSync(file)).digest('hex')]));
writeFileSync('test-artifacts/co-completion/baseline-hashes.json', JSON.stringify(hashes, null, 2));
console.log(JSON.stringify({ types: types.length, lint: lint.length }));

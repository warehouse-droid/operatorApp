import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { files, added } from './child-location-files.mjs';
const require = createRequire('/app/package.json');
const { ESLint } = require('eslint');
const config = (await import('/app/eslint.mbt.config.js')).default;
const label = process.argv[2] || 'current';
const targets = files.filter(file => file.endsWith('.js') && existsSync(file));
const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [...config,
  { ...config[0], files: added.filter(file => file.endsWith('.js')) }
], fix: process.argv.includes('--fix') });
const lint = await eslint.lintFiles(targets);
if (process.argv.includes('--fix')) { await ESLint.outputFixes(lint); }
mkdirSync('test-artifacts/child-locations', { recursive: true });
const typesConfig = `test-artifacts/child-locations/tsconfig-${label}.json`;
writeFileSync(typesConfig, JSON.stringify({ extends: '/app/tsconfig.mbt.json', include: targets.filter(file => file.startsWith('src/')).map(file => `/app/${file}`) }));
const types = spawnSync('node_modules/.bin/tsc', ['--project', typesConfig, '--pretty', 'false'], { encoding: 'utf8' });
writeFileSync(`test-artifacts/child-locations/types-${label}.log`, types.stdout + types.stderr);
const result = { label, lint: lint.flatMap(file => file.messages.map(message => ({ file: file.filePath.replace('/app/', ''), ...message }))),
  types: (types.stdout + types.stderr).trim().split('\n').filter(Boolean), versions: Object.fromEntries(['eslint','typescript','fast-check','c8'].map(name => [name, JSON.parse(readFileSync(require.resolve(`${name}/package.json`),'utf8')).version])) };
writeFileSync(`test-artifacts/child-locations/static-${label}.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ label, lint: result.lint.length, types: result.types.length, versions: result.versions }));

import { ESLint } from 'eslint';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import base from '../eslint.mbt.config.js';

const files = ['src/operator-co-routing.js', 'src/co-source-receipt.js',
  'test/dispatch/integration/co-operator-routing.test.js', 'test/support/co-operator-baseline.mjs',
  'tools/co-operator-gauntlet.mjs', 'tools/run-co-operator-regressions.mjs', 'tools/co-operator-static.mjs',
  'tools/check-co-operator-coverage.mjs'];
const fix = process.argv.includes('--fix');
const eslint = new ESLint({ overrideConfigFile: true, fix,
  overrideConfig: [{ ...base[1], files: ['**/*.js', '**/*.mjs'] }] });
let errors = 0;
for (const file of files) {
  const filename = path.resolve(file);
  const [result] = await eslint.lintText(await readFile(filename, 'utf8'), { filePath: filename });
  if (fix && result.output) {await writeFile(filename, result.output);}
  errors += result.errorCount + result.warningCount;
  for (const message of result.messages) {console.log(`${file}:${message.line}:${message.column} ${message.message}`);}
}
console.log(`CO static lint: ${files.length} files, ${errors} issues`);
process.exitCode = errors ? 1 : 0;

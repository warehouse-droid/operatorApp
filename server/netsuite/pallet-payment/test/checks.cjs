const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (r.status !== 0) { process.exit(r.status || 1); }
}
const sources = fs.readdirSync('.').filter(file => file.startsWith('ppa_') && file.endsWith('.js'));
for (const file of sources) { run('node', ['--check', file]); }
const tests = ['test/core.test.cjs', 'test/service.test.cjs', 'test/adapter.test.cjs', 'test/entrypoint.test.cjs', 'test/upload.test.cjs', 'test/refresh.test.cjs'];
const tools = '/artifacts/toolchain/node_modules';
if (fs.existsSync(tools)) {
  run('node', [`${tools}/eslint/bin/eslint.js`, '--config', 'test/eslint.config.cjs', '--max-warnings=0', ...sources]);
  run('node', [`${tools}/typescript/bin/tsc`, '--allowJs', '--checkJs', '--noEmit', '--skipLibCheck', '--target', 'ES2022', 'test/suitescript.d.ts', ...sources]);
  run('node', [`${tools}/c8/bin/c8.js`, '--all', '--include=ppa_*.js', '--reporter=text', '--reporter=json-summary',
    '--reports-dir=/artifacts/report', '--temp-directory=/artifacts/c8', 'node', '--test', ...tests]);
  run('node', ['test/properties.cjs']);
} else {
  run('node', ['--test', ...tests]);
}
run('node', ['test/mutations.cjs']);
run('node', ['test/example.cjs']);
run('node', ['--test', ...tests.slice().reverse()], { stdio: 'pipe' });
const hash = crypto.createHash('sha256');
for (const file of sources.sort()) { hash.update(file); hash.update(fs.readFileSync(file)); }
console.log(JSON.stringify({ node: process.version, sourceTreeSha256: hash.digest('hex'), changedSourceFiles: sources.length,
  coverage: fs.existsSync('/artifacts/report/coverage-summary.json') ? JSON.parse(fs.readFileSync('/artifacts/report/coverage-summary.json', 'utf8')).total : null }));

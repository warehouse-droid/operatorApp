const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const packages = ['typescript@5.9.3', 'eslint@9.39.1', 'c8@10.1.3', 'fast-check@4.3.0'];
fs.mkdirSync('/artifacts/toolchain', { recursive: true });
fs.writeFileSync('/artifacts/toolchain/package.json', JSON.stringify({ name: 'disposable-pallet-checks', version: '1.0.0', private: true,
  devDependencies: Object.fromEntries(packages.map(value => value.split('@'))) }));
const r = spawnSync('npm', ['install', '--prefix', '/artifacts/toolchain', '--ignore-scripts', '--no-audit', '--no-fund'], {
  stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development' }
});
if (r.status !== 0) { process.exit(r.status || 1); }
console.log('Disposable dev tools installed:', packages.join(', '));
const audit = spawnSync('npm', ['audit', '--prefix', '/artifacts/toolchain', '--include=dev', '--json'], {
  encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development' }
});
const report = JSON.parse(audit.stdout || '{}');
console.log('Disposable tooling audit:', JSON.stringify(report.metadata?.vulnerabilities || report.error || 'unavailable'));
console.log('Direct tool licenses:', JSON.stringify(Object.fromEntries(packages.map(value => {
  const name = value.split('@')[0]; return [name, require(`/artifacts/toolchain/node_modules/${name}/package.json`).license];
}))));
require('./checks.cjs');

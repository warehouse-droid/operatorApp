import { cpSync, mkdtempSync, symlinkSync, readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
const out = 'test-artifacts/sales-order-null-packs-20261016';
const flags = ['/app/node_modules/typescript/bin/tsc', '--allowJs', '--checkJs', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck'];
const files = ['public/order-pack-quantities.js', 'public/special-stock-line-details.js', 'public/special-stock-line-fields.js', 'src/special-stock-request-domain.js', 'src/special-stock-adjustment-adapter.js'];
const core = spawnSync(process.execPath, [...flags, ...files.slice(0, 3), files[4]], { encoding: 'utf8' });
if (core.status !== 0) { process.stdout.write(core.stdout + core.stderr); process.exit(1); }
const root = mkdtempSync('/tmp/so-null-types-');
try {
  for (const dir of ['src', 'public']) cpSync(dir, join(root, dir), { recursive: true });
  copyFileSync('package.json', join(root, 'package.json')); symlinkSync('/app/node_modules', join(root, 'node_modules'));
  const before = `${out}/before`;
  for (const name of readdirSync(before, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    mkdirSync(dirname(join(root, name)), { recursive: true }); copyFileSync(join(before, name), join(root, name));
  }
  const baseline = spawnSync(process.execPath, [...flags, ...files], { cwd: root, encoding: 'utf8' });
  const current = spawnSync(process.execPath, [...flags, ...files], { encoding: 'utf8' });
  writeFileSync(`${out}/types-baseline.log`, baseline.stdout + baseline.stderr);
  writeFileSync(`${out}/types-current.log`, current.stdout + current.stderr);
  const diagnostics = result => result.stdout.split('\n').filter(line => /error TS\d+:/.test(line)).map(line => line.replace(/\(\d+,\d+\)/, '')).sort();
  const previous = diagnostics(baseline), next = diagnostics(current);
  const remaining = [...previous];
  const added = next.filter(line => { const index = remaining.indexOf(line); if (index < 0) return true; remaining.splice(index, 1); return false; });
  if (added.length || current.status !== baseline.status) throw Error('New type diagnostics: ' + JSON.stringify(added));
  writeFileSync(`${out}/types.json`, JSON.stringify({ focusedErrors: 0, baselineErrors: previous.length, currentErrors: next.length, newErrors: 0 }, null, 2));
  console.log(`Focused nullable-pack modules: 0 errors; legacy domain: ${previous.length} baseline, ${next.length} current, 0 new diagnostics`);
} finally { rmSync(root, { recursive: true, force: true }); }

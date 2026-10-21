// Node's test CLI sorts file arguments. Spawn files explicitly to vary order.
import { spawnSync } from 'node:child_process';

let exitCode = 0;
for (const file of process.argv.slice(2)) {
  console.log('# Explicit test file order: ' + file);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', file], {
    encoding: 'utf8', timeout: 90000, maxBuffer: 20000000
  });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.error || result.signal) {
    process.stderr.write(String(result.error || result.signal) + '\n');
  }
  if (result.status !== 0) {exitCode = 1;}
}
process.exitCode = exitCode;
